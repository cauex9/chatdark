import crypto from 'node:crypto';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  buildSubscriptionRequest,
  planKeyFromName,
  processPoseidonWebhook,
  webhookTokenDigest,
  type BillingPlan,
  type BillingSubscription,
  type PoseidonVerifier,
  type VerifiedGatewaySubscription,
  type VerifiedGatewayTransaction,
} from './billing-core';

type AuthenticatedRequest = Request & { uid?: string };
type AttemptRow = {
  id: string;
  user_id: string;
  plan_id: string;
  subscription_id: string;
  idempotency_key: string;
  gateway_identifier: string;
  gateway_transaction_id: string | null;
  gateway_subscription_id: string | null;
  amount: number;
  status: string;
  pix_code: string | null;
  pix_image: string | null;
  expires_at: string | null;
  created_at: string;
};

const clientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(8).max(40),
  document: z.string().trim().min(1).max(32).optional(),
});

const createResponseSchema = z.object({
  transactionId: z.string().min(1),
  status: z.enum(['OK', 'PENDING', 'FAILED']),
  transactionStatus: z.enum(['PENDING', 'COMPLETED', 'FAILED']).optional(),
  webhookToken: z.string().min(1).optional(),
  subscription: z.object({ id: z.string().min(1) }).passthrough().optional(),
  pix: z.object({
    code: z.string().min(1),
    image: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
  }).passthrough().optional(),
}).passthrough();

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validWebhookSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function asPlan(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    price: Number(row.price),
    duration_days: Number(row.duration_days),
    monthly_credits: Number(row.monthly_credits),
    active: row.active === true,
  };
}

function publicAttempt(attempt: AttemptRow, plan: BillingPlan) {
  const key = planKeyFromName(plan.name);
  if (!key) throw new Error('Plano de cobrança inválido.');
  return {
    id: attempt.id,
    status: attempt.status,
    amount: Number(attempt.amount),
    plan: {
      key,
      name: plan.name,
      monthlyCredits: plan.monthly_credits,
      durationDays: plan.duration_days,
    },
    transactionId: attempt.gateway_transaction_id,
    subscriptionId: attempt.gateway_subscription_id,
    pix: attempt.pix_code
      ? {
          code: attempt.pix_code,
          image: attempt.pix_image,
          expiresAt: attempt.expires_at,
        }
      : null,
    createdAt: attempt.created_at,
  };
}

function serviceError(message: string, status = 502, retryable = status >= 500): Error & {
  status: number;
  retryable: boolean;
} {
  return Object.assign(new Error(message), { status, retryable });
}

function isServiceError(error: unknown): error is Error & { status: number; retryable: boolean } {
  return error instanceof Error
    && 'status' in error
    && 'retryable' in error
    && typeof error.status === 'number'
    && typeof error.retryable === 'boolean';
}

async function poseidonRequest(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const publicKey = process.env.POSEIDON_PUBLIC_KEY;
  const secretKey = process.env.POSEIDON_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw serviceError('Gateway indisponível: configure as chaves PoseidonPay no backend.', 503, false);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(`https://app.poseidonpay.site/api/v1${path}`, {
      ...init,
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        'x-public-key': publicKey,
        'x-secret-key': secretKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Tempo esgotado ao consultar a PoseidonPay.'
      : 'Não foi possível conectar à PoseidonPay.';
    throw serviceError(message, 503);
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw serviceError(
      `A PoseidonPay recusou ou não confirmou a solicitação (HTTP ${response.status}).`,
      response.status >= 500 ? 503 : 502,
      response.status >= 500,
    );
  }
  if (data === null) {
    throw serviceError('A PoseidonPay retornou uma resposta sem JSON válido.', 503, true);
  }
  return data;
}

function createPoseidonVerifier(): PoseidonVerifier {
  return {
    async getTransaction(id: string): Promise<VerifiedGatewayTransaction> {
      const query = new URLSearchParams({ id });
      const result = await poseidonRequest(`/gateway/transactions?${query}`);
      const transaction = z.object({
        id: z.string(),
        identifier: z.string().optional().nullable(),
        clientIdentifier: z.string().optional().nullable(),
        status: z.string(),
        amount: z.number().finite(),
        paymentMethod: z.string().optional(),
        purchaseType: z.string().optional(),
        payedAt: z.string().optional().nullable(),
      }).passthrough().parse(result);
      return transaction;
    },
    async getSubscriptions(filters): Promise<VerifiedGatewaySubscription[]> {
      const query = new URLSearchParams();
      if (filters.transactionId) query.set('transactionId', filters.transactionId);
      if (filters.subscriptionId) query.set('subscriptionId', filters.subscriptionId);
      const result = z.object({
        subscriptions: z.array(z.object({
          id: z.string(),
          identifier: z.string().optional().nullable(),
          status: z.string().optional(),
          cycle: z.number().int().positive().optional().nullable(),
          nextChargeAt: z.string().optional().nullable(),
          expiresAt: z.string().optional().nullable(),
        }).passthrough()),
      }).passthrough().parse(await poseidonRequest(`/gateway/subscriptions?${query}`));
      return result.subscriptions;
    },
  };
}

async function findPlan(
  db: SupabaseClient,
  key: string,
): Promise<BillingPlan | null> {
  if (key !== 'basic' && key !== 'starter' && key !== 'pro' && key !== 'premium') return null;
  const { data, error } = await db
    .from('plans')
    .select('id,name,price,duration_days,monthly_credits,active')
    .eq('active', true);
  if (error) throw error;
  const row = (data || []).find((item) => planKeyFromName(item.name) === key);
  return row ? asPlan(row) : null;
}

async function findLocalSubscription(
  db: SupabaseClient,
  filter: { gatewayId?: string; identifier?: string },
): Promise<BillingSubscription | null> {
  let query = db
    .from('subscriptions')
    .select('id,user_id,plan_id,status,gateway_identifier,gateway_subscription_id,plan:plans(id,name,price,duration_days,monthly_credits,active)');
  if (filter.gatewayId) query = query.eq('gateway_subscription_id', filter.gatewayId);
  else if (filter.identifier) query = query.eq('gateway_identifier', filter.identifier);
  else return null;

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const joinedPlan = Array.isArray(data.plan) ? data.plan[0] : data.plan;
  if (!joinedPlan) throw new Error('O plano da assinatura não foi encontrado.');
  return {
    id: data.id,
    user_id: data.user_id,
    plan_id: data.plan_id,
    status: data.status,
    gateway_identifier: data.gateway_identifier,
    gateway_subscription_id: data.gateway_subscription_id,
    plan: asPlan(joinedPlan as Record<string, unknown>),
  };
}

function createWebhookRepository(db: SupabaseClient) {
  return {
    findSubscriptionByGatewayId(id: string) {
      return findLocalSubscription(db, { gatewayId: id });
    },
    findSubscriptionByIdentifier(identifier: string) {
      return findLocalSubscription(db, { identifier });
    },
    async attachGatewaySubscriptionId(subscriptionId: string, gatewayId: string): Promise<void> {
      const { error } = await db
        .from('subscriptions')
        .update({
          gateway_subscription_id: gatewayId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', subscriptionId);
      if (error) throw error;
    },
    async validateInitialWebhookToken(
      transactionId: string,
      token: string,
    ): Promise<'not-found' | 'match' | 'mismatch'> {
      const { data, error } = await db
        .from('webforge_payment_attempts')
        .select('webhook_token_hash')
        .eq('gateway_transaction_id', transactionId)
        .maybeSingle();
      if (error) throw error;
      if (!data?.webhook_token_hash) return 'not-found';
      return safeEqual(data.webhook_token_hash, webhookTokenDigest(token)) ? 'match' : 'mismatch';
    },
    async applyConfirmedCycle(input: {
      subscriptionId: string;
      transactionId: string;
      cycleNumber: number | null;
      amount: number;
      confirmedAt: string;
    }): Promise<boolean> {
      const { data, error } = await db.rpc('apply_webforge_subscription_payment', {
        p_subscription_id: input.subscriptionId,
        p_gateway_transaction_id: input.transactionId,
        p_cycle_number: input.cycleNumber,
        p_amount: input.amount,
        p_confirmed_at: input.confirmedAt,
      });
      if (error) throw error;
      return data === true;
    },
    async markAttemptPaid(transactionId: string, subscriptionId: string): Promise<void> {
      const { error } = await db
        .from('webforge_payment_attempts')
        .update({ status: 'paid', updated_at: new Date().toISOString() })
        .eq('gateway_transaction_id', transactionId);
      if (error) throw error;
      const { error: pendingError } = await db
        .from('webforge_payment_attempts')
        .update({
          status: 'paid',
          gateway_transaction_id: transactionId,
          updated_at: new Date().toISOString(),
        })
        .eq('subscription_id', subscriptionId)
        .in('status', ['creating', 'pending']);
      if (pendingError) throw pendingError;
    },
    async markAttemptFailed(transactionId: string, subscriptionId?: string): Promise<void> {
      const { data, error } = await db
        .from('webforge_payment_attempts')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('gateway_transaction_id', transactionId)
        .select('subscription_id');
      if (error) throw error;
      const relatedIds = new Set((data || []).map((attempt: { subscription_id: string }) => attempt.subscription_id));
      if (subscriptionId) relatedIds.add(subscriptionId);
      for (const relatedId of relatedIds) {
        const { error: attemptError } = await db
          .from('webforge_payment_attempts')
          .update({
            status: 'failed',
            gateway_transaction_id: transactionId,
            updated_at: new Date().toISOString(),
          })
          .eq('subscription_id', relatedId)
          .in('status', ['creating', 'pending']);
        if (attemptError) throw attemptError;
        const { error: subscriptionError } = await db
          .from('subscriptions')
          .update({ status: 'payment_failed', updated_at: new Date().toISOString() })
          .eq('id', relatedId)
          .eq('status', 'pending');
        if (subscriptionError) throw subscriptionError;
      }
    },
    async updateSubscriptionStatus(
      subscriptionId: string,
      status: 'canceled' | 'expired' | 'payment_failed',
    ): Promise<void> {
      const { error } = await db
        .from('subscriptions')
        .update({
          status,
          next_charge_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', subscriptionId);
      if (error) throw error;
      const attemptStatus = status === 'canceled' ? 'canceled' : status === 'expired' ? 'expired' : 'failed';
      const { error: attemptError } = await db
        .from('webforge_payment_attempts')
        .update({ status: attemptStatus, updated_at: new Date().toISOString() })
        .eq('subscription_id', subscriptionId)
        .in('status', ['creating', 'pending']);
      if (attemptError) throw attemptError;
    },
  };
}

async function getAttempt(
  db: SupabaseClient,
  userId: string,
  filter: { idempotencyKey?: string; id?: string },
) {
  let query = db
    .from('webforge_payment_attempts')
    .select('*')
    .eq('user_id', userId);
  if (filter.idempotencyKey) query = query.eq('idempotency_key', filter.idempotencyKey);
  else if (filter.id) query = query.eq('id', filter.id);
  else return null;
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as AttemptRow | null;
}

async function getAttemptPlan(db: SupabaseClient, planId: string): Promise<BillingPlan> {
  const { data, error } = await db
    .from('plans')
    .select('id,name,price,duration_days,monthly_credits,active')
    .eq('id', planId)
    .single();
  if (error) throw error;
  return asPlan(data);
}

function sendAttempt(res: Response, attempt: AttemptRow, plan: BillingPlan): void {
  const code = attempt.status === 'creating' ? 202 : 200;
  res.status(code).json(publicAttempt(attempt, plan));
}

export function registerBillingRoutes(
  app: Express,
  db: SupabaseClient,
  requireAuth: RequestHandler,
): void {
  const router = express.Router();

  router.get('/plans', async (_req, res) => {
    try {
      const { data, error } = await db
        .from('plans')
        .select('id,name,price,duration_days,monthly_credits,active')
        .eq('active', true)
        .order('price', { ascending: true });
      if (error) throw error;
      const plans = (data || []).flatMap((row) => {
        const key = planKeyFromName(row.name);
        if (!key) return [];
        const plan = asPlan(row);
        return [{
          key,
          id: plan.id,
          name: plan.name,
          price: plan.price,
          durationDays: plan.duration_days,
          monthlyCredits: plan.monthly_credits,
        }];
      });
      res.json({ plans });
    } catch (error) {
      console.error('Falha ao carregar planos:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Não foi possível carregar os planos.' });
    }
  });

  router.post('/webhooks/poseidon/:secret', async (req, res) => {
    const expectedSecret = process.env.POSEIDON_WEBHOOK_SECRET;
    if (!expectedSecret) {
      res.status(503).json({ error: 'Webhook PoseidonPay não configurado.' });
      return;
    }
    if (!validWebhookSecret(expectedSecret)) {
      res.status(503).json({ error: 'POSEIDON_WEBHOOK_SECRET deve ter ao menos 32 caracteres URL-safe.' });
      return;
    }
    if (!safeEqual(req.params.secret, expectedSecret)) {
      res.status(401).json({ error: 'Webhook não autorizado.' });
      return;
    }

    try {
      const result = await processPoseidonWebhook(
        req.body,
        createWebhookRepository(db),
        createPoseidonVerifier(),
      );
      res.status(200).json({ received: true, ...result });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof Error && error.name === 'InvalidWebhookError') {
        res.status(400).json({ error: 'Payload do webhook inválido ou não confirmado.' });
        return;
      }
      console.error('Falha ao processar webhook PoseidonPay:', error instanceof Error ? error.message : error);
      res.status(503).json({ error: 'Webhook não processado; a PoseidonPay pode tentar novamente.' });
    }
  });

  router.post('/plans/:plan/subscription/pix', requireAuth, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.uid) {
      res.status(401).json({ error: 'Faça login.' });
      return;
    }

    const key = req.get('Idempotency-Key')?.trim();
    if (!key || key.length > 120) {
      res.status(400).json({ error: 'Chave de idempotência inválida.' });
      return;
    }

    try {
      const existing = await getAttempt(db, authReq.uid, { idempotencyKey: key });
      if (existing) {
        const plan = await getAttemptPlan(db, existing.plan_id);
        sendAttempt(res, existing, plan);
        return;
      }

      const callbackUrl = process.env.POSEIDON_WEBHOOK_URL;
      const webhookSecret = process.env.POSEIDON_WEBHOOK_SECRET;
      if (!callbackUrl || !webhookSecret || !validWebhookSecret(webhookSecret)) {
        res.status(503).json({ error: 'Configure o webhook PoseidonPay no backend antes de criar cobranças.' });
        return;
      }
      let callback: URL;
      try {
        callback = new URL(callbackUrl);
      } catch {
        res.status(503).json({ error: 'POSEIDON_WEBHOOK_URL não é uma URL válida.' });
        return;
      }
      if (
        callback.protocol !== 'https:'
        || !callback.pathname.endsWith(`/api/webhooks/poseidon/${webhookSecret}`)
      ) {
        res.status(503).json({ error: 'Configure uma URL HTTPS terminada no endpoint de webhook e no segredo correto.' });
        return;
      }

      if (!process.env.POSEIDON_PUBLIC_KEY || !process.env.POSEIDON_SECRET_KEY) {
        res.status(503).json({ error: 'Configure as chaves PoseidonPay no backend.' });
        return;
      }

      const client = clientSchema.safeParse(req.body?.client);
      if (!client.success) {
        res.status(400).json({ error: 'Dados do cliente inválidos.' });
        return;
      }

      const plan = await findPlan(db, req.params.plan);
      if (!plan) {
        res.status(404).json({ error: 'Plano ativo não encontrado.' });
        return;
      }

      const identifier = crypto.randomUUID();
      const { data: subscription, error: subscriptionError } = await db
        .from('subscriptions')
        .insert({
          user_id: authReq.uid,
          plan_id: plan.id,
          status: 'pending',
          payment_method: 'PIX',
          gateway_identifier: identifier,
        })
        .select('id')
        .single();
      if (subscriptionError) throw subscriptionError;

      const { data: attempt, error: attemptError } = await db
        .from('webforge_payment_attempts')
        .insert({
          user_id: authReq.uid,
          plan_id: plan.id,
          subscription_id: subscription.id,
          idempotency_key: key,
          gateway_identifier: identifier,
          amount: plan.price,
          status: 'creating',
        })
        .select('*')
        .single();
      if (attemptError) {
        const { error: cleanupError } = await db.from('subscriptions').delete().eq('id', subscription.id);
        if (cleanupError) throw cleanupError;
        if (attemptError.code === '23505') {
          const winner = await getAttempt(db, authReq.uid, { idempotencyKey: key });
          if (winner) {
            sendAttempt(res, winner, await getAttemptPlan(db, winner.plan_id));
            return;
          }
        }
        throw attemptError;
      }

      let responseData: unknown;
      try {
        responseData = await poseidonRequest('/gateway/pix/subscription', {
          method: 'POST',
          body: JSON.stringify(buildSubscriptionRequest(
            plan,
            identifier,
            client.data,
            callbackUrl,
            subscription.id,
          )),
        });
      } catch (error) {
        console.error('Falha ao solicitar assinatura à PoseidonPay:', error instanceof Error ? error.message : error);
        if (isServiceError(error) && !error.retryable) {
          const { error: attemptUpdateError } = await db
            .from('webforge_payment_attempts')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', attempt.id);
          if (attemptUpdateError) throw attemptUpdateError;
          const { error: subscriptionUpdateError } = await db
            .from('subscriptions')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', subscription.id);
          if (subscriptionUpdateError) throw subscriptionUpdateError;
        }
        const statusCode = isServiceError(error) ? error.status : 503;
        res.status(statusCode).json({
          error: 'Não foi possível confirmar a criação da cobrança. Reenvie a mesma chave de idempotência; outra cobrança não será criada.',
        });
        return;
      }

      const parsed = createResponseSchema.safeParse(responseData);
      if (!parsed.success) {
        res.status(502).json({
          error: 'A resposta da PoseidonPay não segue o formato documentado; a tentativa foi preservada para evitar cobrança duplicada.',
        });
        return;
      }

      if (parsed.data.status === 'FAILED' || parsed.data.transactionStatus === 'FAILED') {
        const { error: attemptUpdateError } = await db
          .from('webforge_payment_attempts')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', attempt.id);
        if (attemptUpdateError) throw attemptUpdateError;
        const { error: subscriptionUpdateError } = await db
          .from('subscriptions')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', subscription.id);
        if (subscriptionUpdateError) throw subscriptionUpdateError;
        res.status(502).json({ error: 'A PoseidonPay não retornou uma cobrança Pix válida.' });
        return;
      }

      if (!parsed.data.subscription?.id || !parsed.data.pix?.code) {
        res.status(502).json({
          error: 'A resposta da PoseidonPay não incluiu os identificadores/QR Pix esperados; a tentativa foi preservada para reconciliação.',
        });
        return;
      }

      const pix = parsed.data.pix;
      const { data: savedAttempt, error: saveAttemptError } = await db
        .from('webforge_payment_attempts')
        .update({
          gateway_transaction_id: parsed.data.transactionId,
          gateway_subscription_id: parsed.data.subscription.id,
          pix_code: pix.code,
          pix_image: pix.image || null,
          expires_at: pix.expiresAt || null,
          webhook_token_hash: parsed.data.webhookToken
            ? webhookTokenDigest(parsed.data.webhookToken)
            : null,
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', attempt.id)
        .select('*')
        .single();
      if (saveAttemptError) throw saveAttemptError;

      const { error: saveSubscriptionError } = await db
        .from('subscriptions')
        .update({
          gateway_transaction_id: parsed.data.transactionId,
          gateway_subscription_id: parsed.data.subscription.id,
          gateway_identifier: identifier,
          payment_method: 'PIX',
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', subscription.id);
      if (saveSubscriptionError) throw saveSubscriptionError;

      res.status(201).json(publicAttempt(savedAttempt as AttemptRow, plan));
    } catch (error) {
      console.error('Falha ao criar assinatura:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Não foi possível iniciar a assinatura.' });
    }
  });

  router.get('/billing/payment-attempts/:id', requireAuth, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.uid) {
      res.status(401).json({ error: 'Faça login.' });
      return;
    }
    try {
      const attempt = await getAttempt(db, authReq.uid, { id: req.params.id });
      if (!attempt) {
        res.status(404).json({ error: 'Cobrança não encontrada.' });
        return;
      }
      sendAttempt(res, attempt, await getAttemptPlan(db, attempt.plan_id));
    } catch (error) {
      console.error('Falha ao consultar cobrança:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Não foi possível consultar a cobrança.' });
    }
  });

  router.get('/billing/subscriptions', requireAuth, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.uid) {
      res.status(401).json({ error: 'Faça login.' });
      return;
    }
    try {
      const { data, error } = await db
        .from('subscriptions')
        .select('id,plan_id,status,starts_at,expires_at,gateway_subscription_id,gateway_transaction_id,last_payment_at,next_charge_at,plan:plans(name,price,monthly_credits,duration_days)')
        .eq('user_id', authReq.uid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ subscriptions: data || [] });
    } catch (error) {
      console.error('Falha ao consultar assinaturas:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Não foi possível consultar as assinaturas.' });
    }
  });

  router.post('/plans/:plan/pix', requireAuth, (_req, res) => {
    res.status(410).json({
      error: 'Cobranças avulsas de plano foram desativadas. Use a rota de assinatura recorrente.',
    });
  });

  app.use('/api', router);
}
