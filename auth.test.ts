import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app.js';

describe('auth flow', () => {
  it('rejects signup with an invalid email', async () => {
    const res = await request(app)
      .post('/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
  });

  it('signs up a new user and logs in', async () => {
    const email = `test-${Date.now()}@test.com`;

    const signupRes = await request(app)
      .post('/signup')
      .send({ email, password: 'password123' });

    expect(signupRes.status).toBe(201);

    const loginRes = await request(app)
      .post('/login')
      .send({ email, password: 'password123' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
  });

 
});