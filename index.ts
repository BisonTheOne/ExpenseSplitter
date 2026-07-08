import 'dotenv/config';
import Express from "express" ;
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg }     from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { email, z } from 'zod';
import { error } from "node:console";
import type { Request, Response, NextFunction } from 'express';

interface AuthRequest extends Request {
  userId?: number;
}

const app = Express();
app.use(Express.json());
app.use(Express.static('public'));


const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set in environment variables');
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction){
    const authHeader = req.headers.authorization;
    
    if(!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({error: 'Missing token' });
    }
    const token = authHeader.split(' ')[1];

    try{
        const payload = jwt.verify(token, JWT_SECRET as string) as unknown as { userId: number };
        req.userId = payload.userId;
        next();
    }
    catch{
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}



const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });


app.post('/tickets', requireAuth, async(req,res)=>{
    const tickets = await prisma.ticket.create({data: req.body});
    res.status(201).json(tickets)
});

app.get('/tickets', requireAuth, async(req, res)=>{
    const tickets = await prisma.ticket.findMany();
    return res.json(tickets);
});


const signupSchema = z.object({
    email:  z.string().email(),
    password: z.string().min(8),
});

app.post('/signup', async(req,res)=>{
    const parsed = signupSchema.safeParse(req.body);

        if(!parsed.success){
            return res.status(400).json({error: parsed.error.flatten()});
        }

    const {email, password} = parsed.data;

    const existing = await prisma.user.findUnique({where: {email}});
        if (existing){
            return res.status(409).json({error: 'Email already registered'});
        }
    const hashedPassword = await bcrypt.hash(password,10);
    const user = await prisma.user.create({
        data:{email, 
            password: hashedPassword
        }
    });

    res.status(201).json({id: user.id, email: user.email });
});


const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});

app.post('/login', async(req,res) =>{
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success)
        return res.status(400).json({error: parsed.error.flatten() });

    const {email, password} = parsed.data;

    const user = await prisma.user.findUnique( { where:{email} } )

    if (!user)
        return res.status(401).json({error: 'Invalid credentials' });
    

    const validPassword = await bcrypt.compare(password, user.password);

    if(!validPassword)
        return res.status(401).json({error: 'Invalid credentials' });

    const token = jwt.sign(
            {userId: user.id},
            JWT_SECRET,
            {expiresIn: '1h'}
            );

    res.json({token});
});

app.listen(3000, () =>{
    console.log("Listening on port 3000");
    console.log("http://localhost:3000");
});

