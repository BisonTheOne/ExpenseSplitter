import { describe, it, expect } from "vitest";
import request from "supertest";
import app from './app.js';

async function signupAndLogin(email: string) {
  await request(app).post('/signup').send({ email, password: 'password123' });
  const res = await request(app).post('/login').send({ email, password: 'password123' });
  return res.body.token;
}

describe('expense balances', () => {
  it('computes correct net balances that sum to zero', async () => {
    const suffix = Date.now();
    const alexEmail = `alex-${suffix}@test.com`;
    const samEmail = `sam-${suffix}@test.com`;
    const jordanEmail = `jordan-${suffix}@test.com`;

    const alexToken = await signupAndLogin(alexEmail);
    const samToken = await signupAndLogin(samEmail);
    const jordanToken = await signupAndLogin(jordanEmail);

    // Alex creates the group (auto-joins)
    const groupRes = await request(app)
      .post('/groups')
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ name: 'Test Trip' });
    const groupId = groupRes.body.id;

    // Alex adds Sam and Jordan
    await request(app)
      .post(`/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ email: samEmail });

    await request(app)
      .post(`/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ email: jordanEmail });

    // Three expenses, each paid by a different member, equal split
    await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ description: 'Dinner', amount: 30, groupId, splitType: 'equal' });

    await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${samToken}`)
      .send({ description: 'Groceries', amount: 15, groupId, splitType: 'equal' });

    await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${jordanToken}`)
      .send({ description: 'Coffee', amount: 9, groupId, splitType: 'equal' });

    // Check balances
    const balancesRes = await request(app)
      .get(`/groups/${groupId}/balances`)
      .set('Authorization', `Bearer ${alexToken}`);
    expect(balancesRes.status).toBe(200);

    const balances = balancesRes.body;
    const total = Object.values(balances).reduce((sum: number, b) => sum + (b as number), 0);

    // The core invariant: balances must always sum to zero
    expect(total).toBeCloseTo(0, 2);
  });

  it('produces settle-up transactions that resolve all balances', async () => {
    const suffix = Date.now();
    const alexEmail = `alex2-${suffix}@test.com`;
    const samEmail = `sam2-${suffix}@test.com`;
    const jordanEmail = `jordan2-${suffix}@test.com`;

    const alexToken = await signupAndLogin(alexEmail);
    const samToken = await signupAndLogin(samEmail);
    const jordanToken = await signupAndLogin(jordanEmail);

    const groupRes = await request(app)
      .post('/groups')
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ name: 'Settle Test' });
    expect(groupRes.status).toBe(201);
    const groupId = groupRes.body.id;

    const addSam = await request(app)
      .post(`/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ email: samEmail });
    expect(addSam.status).toBe(201);

    const addJordan = await request(app)
      .post(`/groups/${groupId}/members`)
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ email: jordanEmail });
    expect(addJordan.status).toBe(201);

    const expA = await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ description: 'Dinner', amount: 30, groupId, splitType: 'equal' });
    expect(expA.status).toBe(201);

    const expB = await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${samToken}`)
      .send({ description: 'Groceries', amount: 15, groupId, splitType: 'equal' });
    expect(expB.status).toBe(201);

    const expC = await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${jordanToken}`)
      .send({ description: 'Coffee', amount: 9, groupId, splitType: 'equal' });
    expect(expC.status).toBe(201);

    const settleRes = await request(app)
      .get(`/groups/${groupId}/settle-up`)
      .set('Authorization', `Bearer ${alexToken}`);

    expect(settleRes.status).toBe(200);

    const transactions = settleRes.body as { from: number; to: number; amount: number }[];

    // Apply every transaction back onto the original balances — the result should be all zeros
    const balancesRes = await request(app)
      .get(`/groups/${groupId}/balances`)
      .set('Authorization', `Bearer ${alexToken}`);
    const balances = { ...balancesRes.body };

    for (const t of transactions) {
      balances[t.from] += t.amount;
      balances[t.to] -= t.amount;
    }

    for (const remaining of Object.values(balances)) {
      expect(remaining as number).toBeCloseTo(0, 2);
    }
});

  it('rejects balance requests from non-members', async () => {
    const suffix = Date.now();
    const ownerToken = await signupAndLogin(`owner-${suffix}@test.com`);
    const outsiderToken = await signupAndLogin(`outsider-${suffix}@test.com`);

    const groupRes = await request(app)
      .post('/groups')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Private Group' });

    const res = await request(app)
      .get(`/groups/${groupRes.body.id}/balances`)
      .set('Authorization', `Bearer ${outsiderToken}`);
      
    expect(res.status).toBe(403);
  });
});