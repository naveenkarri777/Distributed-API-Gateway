// services/payment-service/index.ts
//
// Payment Service Stub:
// Runs on port 4003. Handles transactions and billing.
// Serves /payments/* independently without direct knowledge of the gateway.

import express from 'express';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PAYMENT_SERVICE_PORT ?? '4003', 10);

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  method: 'card' | 'upi' | 'paypal';
  status: 'pending' | 'success' | 'failed';
  timestamp: string;
}

// In-memory data store for payments
const payments: Record<string, Payment> = {
  'pay_501': {
    id: 'pay_501',
    orderId: '101',
    amount: 180,
    currency: 'USD',
    method: 'card',
    status: 'success',
    timestamp: '2026-10-01T10:05:00.000Z',
  },
  'pay_502': {
    id: 'pay_502',
    orderId: '102',
    amount: 350,
    currency: 'USD',
    method: 'upi',
    status: 'success',
    timestamp: '2026-10-02T14:32:00.000Z',
  },
  'pay_503': {
    id: 'pay_503',
    orderId: '103',
    amount: 520,
    currency: 'USD',
    method: 'paypal',
    status: 'pending',
    timestamp: '2026-10-03T08:16:00.000Z',
  },
};

// GET /payments -> list all payments (or filter by ?orderId=...)
app.get('/payments', (req, res) => {
  const orderId = req.query.orderId as string | undefined;
  console.log(`[payment-service] GET /payments ${orderId ? `(filter orderId: ${orderId})` : ''}`);

  if (orderId) {
    const filtered = Object.values(payments).filter((p) => p.orderId === orderId);
    return res.json({ payments: filtered, count: filtered.length });
  }

  return res.json({ payments: Object.values(payments), count: Object.keys(payments).length });
});

// GET /payments/:id -> get a specific payment
app.get('/payments/:id', (req, res) => {
  console.log(`[payment-service] GET /payments/${req.params.id}`);
  const payment = payments[req.params.id];
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found', id: req.params.id });
  }
  return res.json({ payment });
});

// POST /payments -> process a payment
app.post('/payments', (req, res) => {
  console.log('[payment-service] POST /payments', req.body);
  const { orderId, amount, currency = 'USD', method } = req.body as {
    orderId?: string;
    amount?: number;
    currency?: string;
    method?: 'card' | 'upi' | 'paypal';
  };

  if (!orderId || amount === undefined || !method) {
    return res.status(400).json({
      error: 'Invalid payment data',
      message: 'orderId, amount (number), and method (card|upi|paypal) are required',
    });
  }

  const newId = `pay_${Date.now()}`;
  const newPayment: Payment = {
    id: newId,
    orderId,
    amount,
    currency,
    method,
    status: 'success',
    timestamp: new Date().toISOString(),
  };

  payments[newId] = newPayment;
  return res.status(201).json({ message: 'Payment processed successfully', payment: newPayment });
});

app.listen(PORT, () => {
  console.log(`[payment-service] Running on port :${PORT}`);
  console.log('[payment-service] Routes: GET /payments, GET /payments/:id, POST /payments');
});
