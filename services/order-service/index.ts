// services/order-service/index.ts
//
// Order Service Stub:
// Runs on port 4002. Manages orders and cart items.
// Serves /orders/* independently without direct knowledge of the gateway.

import express from 'express';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.ORDER_SERVICE_PORT ?? '4002', 10);

export interface Order {
  id: string;
  userId: string;
  items: string[];
  total: number;
  status: 'pending' | 'processing' | 'shipped' | 'completed' | 'cancelled';
  createdAt: string;
}

// In-memory data store for orders
const orders: Record<string, Order> = {
  '101': {
    id: '101',
    userId: '1',
    items: ['Mechanical Keyboard', 'Wireless Mouse'],
    total: 180,
    status: 'completed',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  '102': {
    id: '102',
    userId: '2',
    items: ['4K Ultra HD Monitor'],
    total: 350,
    status: 'shipped',
    createdAt: '2026-10-02T14:30:00.000Z',
  },
  '103': {
    id: '103',
    userId: '123',
    items: ['Ergonomic Chair', 'USB-C Docking Station'],
    total: 520,
    status: 'processing',
    createdAt: '2026-10-03T08:15:00.000Z',
  },
};

// GET /orders -> list all orders (or filter by ?userId=...)
app.get('/orders', (req, res) => {
  const userId = req.query.userId as string | undefined;
  console.log(`[order-service] GET /orders ${userId ? `(filter userId: ${userId})` : ''}`);

  if (userId) {
    const filtered = Object.values(orders).filter((o) => o.userId === userId);
    return res.json({ orders: filtered, count: filtered.length });
  }

  return res.json({ orders: Object.values(orders), count: Object.keys(orders).length });
});

// GET /orders/:id -> get a specific order
app.get('/orders/:id', (req, res) => {
  console.log(`[order-service] GET /orders/${req.params.id}`);
  const order = orders[req.params.id];
  if (!order) {
    return res.status(404).json({ error: 'Order not found', id: req.params.id });
  }
  return res.json({ order });
});

// POST /orders -> create a new order
app.post('/orders', (req, res) => {
  console.log('[order-service] POST /orders', req.body);
  const { userId, items, total } = req.body as {
    userId?: string;
    items?: string[];
    total?: number;
  };

  if (!userId || !items || !Array.isArray(items) || items.length === 0 || total === undefined) {
    return res.status(400).json({
      error: 'Invalid order data',
      message: 'userId, items (array), and total (number) are required',
    });
  }

  const newId = String(Date.now());
  const newOrder: Order = {
    id: newId,
    userId,
    items,
    total,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  orders[newId] = newOrder;
  return res.status(201).json({ message: 'Order created successfully', order: newOrder });
});

app.listen(PORT, () => {
  console.log(`[order-service] Running on port :${PORT}`);
  console.log('[order-service] Routes: GET /orders, GET /orders/:id, POST /orders');
});
