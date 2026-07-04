import Express from "express" ;
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg }     from '@prisma/adapter-pg';
import 'dotenv/config';

const app = Express();
app.use(Express.json());

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

app.get('/',(req,res)=>{
res.send("Hello world!!");
});

app.get('/tickets', async(req,res)=>{
    const tickets = await prisma.ticket.findMany();
    res.json(tickets);
});

app.post('/tickets', async(req,res)=>{
    const tickets = await prisma.ticket.create({data: req.body});
    res.status(201).json(tickets)
});



app.listen(3000, () =>{
    console.log("Listening on port 3000");
    console.log("http://localhost:3000");
});

