import 'dotenv/config';
import Express from "express" ;
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg }     from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { email, z } from 'zod';
import { error, group } from "node:console";
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
        const payload = jwt.verify(token!, JWT_SECRET as string) as unknown as { userId: number };
        req.userId = payload.userId;
        next();
    }
    catch{
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

interface Balance { userId: number; amount: number; }

function simplifyDebts(balances: Record<number, number>): { from: number; to: number; amount: number }[] {
  const creditors: Balance[] = [];
  const debtors: Balance[] = [];

  for (const [userId, amount] of Object.entries(balances)) {
    if (amount > 0.01) creditors.push({ userId: Number(userId), amount });
    else if (amount < -0.01) debtors.push({ userId: Number(userId), amount: -amount }); 
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions: { from: number; to: number; amount: number }[] = [];
  let i = 0, j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i]!;
    const creditor = creditors[j]!;
    const amount = Math.min(debtor.amount, creditor.amount);

    transactions.push({ from: debtor.userId, to: creditor.userId, amount: Math.round(amount * 100) / 100 });

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount < 0.01) i++;   
    if (creditor.amount < 0.01) j++; 
  }

  return transactions;
}

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

const createGroupSchema = z.object({
    name: z.string().min(1),
});

const addMemberSchema = z.object({
  email: z.string().email(),
});

const createExpenseSchema = z.object({
    description: z.string().min(1),
    amount: z.number().positive(),
    groupId: z.number(),
    splitType: z.enum(['equal','exact','percentage']).default('equal'),
    splits: z
        .array(z.object({userId: z.number(), value: z.number() }))
        .optional(),
});


async function getGroupBalance(groupId:number){
    const expenses = await prisma.expense.findMany({
        where: {groupId},
        include: {participants: true},
    });

    const balances: Record<number,number> = {};

    for (const expense of expenses){
        balances[expense.paidById]=(balances[expense.paidById] ?? 0) + expense.amount;
        for (const participant of expense.participants){
            balances[participant.userId]= (balances[participant.userId] ?? 0) - participant.shareOwed;
        }
    }

    return balances;

}

app.get('/groups/:groupId/balances', requireAuth, async (req:AuthRequest,res) => {
    const groupId = Number(req.params.groupId);

    const membership = await prisma.groupMember.findUnique({where:
        {groupId_userId: {groupId, userId: req.userId!}},
    });

    if(!membership){
        return res.status(403).json({error: 'You are not a member of this group' });
    }

    const balances = await getGroupBalance(groupId);
    res.json(balances);
});

app.get('/groups/:groupId/settle-up', requireAuth, async (req: AuthRequest, res) => {
  const groupId = Number(req.params.groupId);

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: req.userId! } },
  });
  if (!membership) {
    return res.status(403).json({ error: 'You are not a member of this group' });
  }

  const balances = await getGroupBalance(groupId);
  const transactions = simplifyDebts(balances);

  res.json(transactions);
});

function splitEqually(amount: number, memberCount: number): number[] {
  const cents = Math.round(amount * 100);
  const baseShare = Math.floor(cents / memberCount);
  const remainder = cents - baseShare * memberCount;

  const shares = Array(memberCount).fill(baseShare);
  for (let i = 0; i < remainder; i++) {
    shares[i] += 1;
  }

  return shares.map((c) => c / 100);
}

function splitExact(amount: number, splits: { userId: number; value: number }[]): { userId: number; shareOwed: number }[] {
  const totalCents = Math.round(amount * 100);
  const splitCents = splits.reduce((sum, s) => sum + Math.round(s.value * 100), 0);

  if (splitCents !== totalCents) {
    throw new Error(`Exact splits must sum to the total amount. Got ${splitCents / 100}, expected ${totalCents / 100}`);
  }

  return splits.map((s) => ({ userId: s.userId, shareOwed: s.value }));
}

function splitByPercentage(amount: number, splits: { userId: number; value: number }[]): { userId: number; shareOwed: number }[] {
  const totalPercent = splits.reduce((sum, s) => sum + s.value, 0);

  if (Math.round(totalPercent * 100) !== 10000) { // 100.00%
    throw new Error(`Percentages must sum to 100. Got ${totalPercent}`);
  }

  const cents = Math.round(amount * 100);
  const shares = splits.map((s) => Math.round((cents * s.value) / 100));

  const drift = cents - shares.reduce((a, b) => a + b, 0);
  shares[shares.length - 1]! += drift;

  return splits.map((s, i) => ({ userId: s.userId, shareOwed: shares[i]! / 100 }));
}

app.post('/groups/:groupId/members', requireAuth, async(req:AuthRequest, res) => {
    const groupId = Number(req.params.groupId);
    const parsed = addMemberSchema.safeParse(req.body);

    if(!parsed.success){
        return res.status(400).json({error: parsed.error.flatten() });
    }

    const {email} = parsed.data;

    const userToAdd = await prisma.user.findUnique({where:{email}});
        if(!userToAdd){
            return res.status(404).json({error: 'No user with that email'});
        }
    const requesterMembership = await prisma.groupMember.findUnique({
        where: {groupId_userId: { groupId, userId: req.userId! }}
    });
        if(!requesterMembership){
            return res.status(403).json({error:'You are not a member of this group'});
        }

    
    try{
        const member = await prisma.groupMember.create({
        data:{
            groupId,
            userId: userToAdd.id
        },
    });
        res.status(201).json(member);

    }catch(err: any){
        if(err.code == 'P2002')
            return res.status(409).json({error: 'User is already a member of this group'});
        throw err;   
    }
});

app.post('/groups', requireAuth, async (req:AuthRequest,res) => {
    const parsed = createGroupSchema.safeParse(req.body);

    if(!parsed.success){
        return res.status(400).json({error: parsed.error.flatten()});
    }

    const {name} = parsed.data;

    const group = await prisma.group.create({
        data:{
            name,
            members: {
                create: {userId: req.userId!},
            }
        }
    });
    res.status(201).json(group);
});

app.post('/expenses', requireAuth, async (req:AuthRequest,res) => {
    const parsed = createExpenseSchema.safeParse(req.body);
    if(!parsed.success){
            return res.status(400).json({error: parsed.error.flatten()});
        }
    
    const {description, amount, groupId, splitType, splits} = parsed.data;
    
    const membership = prisma.groupMember.findUnique({where:
        { groupId_userId: {groupId, userId: req.userId!}},
    });
    if(!membership){
        return res.status(403).json({error:'You are not a member of this group'});
    }
    const members = await prisma.groupMember.findMany({where:{groupId}});

    let participantData: {userId: number; shareOwed:number}[];

     try {

    if (splitType === 'equal') {
      const shares = splitEqually(amount, members.length);
      participantData = members.map((m, i) => ({ userId: m.userId, shareOwed: shares[i]! }));

    } else if (splitType === 'exact') {

      if (!splits) return res.status(400).json({ error: 'splits required for exact split type' });
      participantData = splitExact(amount, splits);

    } else {

      if (!splits) return res.status(400).json({ error: 'splits required for percentage split type' });
      participantData = splitByPercentage(amount, splits);
    }

  } catch (err: any) {

    return res.status(400).json({ error: err.message });

  }

   const expense = await prisma.expense.create({
    data: {
      description,
      amount,
      groupId,
      paidById: req.userId!,
      participants: { create: participantData },
    },
    include: { participants: true },
  });

    res.status(201).json(expense);
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

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export default app;