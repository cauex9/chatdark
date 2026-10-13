import { useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, X } from 'lucide-react';

type PlanKey = 'basic' | 'starter' | 'pro' | 'premium';
type Plan = {
  key: PlanKey;
  id: string;
  name: string;
  price: number;
  durationDays: number;
  monthlyCredits: number;
};
type PaymentAttempt = {
  id: string;
  status: 'creating' | 'pending' | 'paid' | 'failed' | 'expired' | 'canceled';
  amount: number;
  plan: { key: PlanKey; name: string; monthlyCredits: number; durationDays: number };
  transactionId: string | null;
  subscriptionId: string | null;
  pix: { code: string; image: string | null; expiresAt: string | null } | null;
  createdAt: string;
};
type Props = { token: string; email: string; onLogin: () => void };
type Client = { name: string; email: string; phone: string; document: string };

const api = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const storageKey = (email: string) => `webforge:pending-payment:${email.toLowerCase()}`;
const pendingStates = new Set(['creating', 'pending']);
const terminalStates = new Set(['paid', 'failed', 'expired', 'canceled']);
const money = (amount: number) => amount.toLocaleString('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function statusLabel(status: PaymentAttempt['status']): string {
  const labels: Record<PaymentAttempt['status'], string> = {
    creating: 'Aguardando resposta do gateway',
    pending: 'Pagamento pendente',
    paid: 'Pagamento confirmado',
    failed: 'Pagamento não concluído',
    expired: 'Cobrança expirada',
    canceled: 'Cobrança cancelada',
  };
  return labels[status];
}

export default function Plans({ token, email, onLogin }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [client, setClient] = useState<Client>({ name: '', email, phone: '', document: '' });
  const [charge, setCharge] = useState<PaymentAttempt | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loadingPlans, setLoadingPlans] = useState(true);
  const notifiedPayment = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetch(`${api}/api/plans`)
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
        return data.plans as Plan[];
      })
      .then(data => { if (mounted) setPlans(data); })
      .catch(error => {
        if (mounted) setMessage(error instanceof Error ? error.message : 'Não foi possível carregar os planos.');
      })
      .finally(() => { if (mounted) setLoadingPlans(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!token || !email) return;
    const stored = localStorage.getItem(storageKey(email));
    if (!stored) return;

    let saved: { key: string; planKey: PlanKey };
    try {
      saved = JSON.parse(stored) as { key: string; planKey: PlanKey };
    } catch {
      localStorage.removeItem(storageKey(email));
      return;
    }
    const savedPlan = plans.find(item => item.key === saved.planKey);
    if (!savedPlan) return;

    let mounted = true;
    fetch(`${api}/api/plans/${saved.planKey}/subscription/pix`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': saved.key },
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
        return data as PaymentAttempt;
      })
      .then(attempt => {
        if (!mounted) return;
        setPlan(savedPlan);
        setIdempotencyKey(saved.key);
        setCharge(attempt);
        if (terminalStates.has(attempt.status)) {
          localStorage.removeItem(storageKey(email));
          if (attempt.status === 'paid' && notifiedPayment.current !== attempt.id) {
            notifiedPayment.current = attempt.id;
            window.dispatchEvent(new Event('webforge:credits-updated'));
          }
        }
      })
      .catch(error => {
        if (mounted) setMessage(error instanceof Error ? error.message : 'Não foi possível recuperar a cobrança pendente.');
      });
    return () => { mounted = false; };
  }, [token, email, plans]);

  useEffect(() => {
    if (!token || !charge?.id || !pendingStates.has(charge.status)) return;
    let mounted = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${api}/api/billing/payment-attempts/${charge.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
        if (!mounted) return;
        const updated = data as PaymentAttempt;
        setCharge(updated);
        if (terminalStates.has(updated.status)) {
          localStorage.removeItem(storageKey(email));
          if (updated.status === 'paid' && notifiedPayment.current !== updated.id) {
            notifiedPayment.current = updated.id;
            window.dispatchEvent(new Event('webforge:credits-updated'));
          }
        }
      } catch (error) {
        if (mounted) setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar o status do pagamento.');
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [token, email, charge?.id, charge?.status]);

  function choosePlan(selected: Plan) {
    if (!token) {
      onLogin();
      return;
    }
    if (charge && pendingStates.has(charge.status)) {
      const pendingPlan = plans.find(item => item.key === charge.plan.key) || selected;
      setPlan(pendingPlan);
      setMessage('Você já tem uma cobrança pendente. Conclua ou aguarde a confirmação antes de iniciar outra.');
      return;
    }
    setPlan(selected);
    setClient(current => ({ ...current, email: email || current.email }));
    setCharge(null);
    setIdempotencyKey(window.crypto.randomUUID());
    setMessage('');
  }

  async function createCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || !idempotencyKey) return;
    setBusy(true);
    setMessage('');
    localStorage.setItem(storageKey(email), JSON.stringify({ key: idempotencyKey, planKey: plan.key }));
    try {
      const response = await fetch(`${api}/api/plans/${plan.key}/subscription/pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          client: {
            name: client.name,
            email: client.email,
            phone: client.phone,
            ...(client.document ? { document: client.document } : {}),
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Não foi possível criar a cobrança (HTTP ${response.status}).`);
      setCharge(data as PaymentAttempt);
      if (!data.pix?.code && data.status === 'creating') {
        setMessage('A solicitação está sendo reconciliada. Esta mesma tentativa será reutilizada para evitar cobrança duplicada.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao criar cobrança Pix.');
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!charge?.pix?.code) return;
    try {
      await navigator.clipboard.writeText(charge.pix.code);
      setMessage('Código Pix copiado.');
    } catch {
      setMessage('Não foi possível copiar o código Pix neste navegador.');
    }
  }

  function closeDialog() {
    setPlan(null);
    setMessage('');
  }

  return <>
    <section className="max-w-5xl mx-auto px-5 py-16 text-center">
      <h2 className="text-3xl font-bold mb-3">Planos</h2>
      <p className="muted mb-8">Assinatura recorrente via Pix, com ciclos de acordo com o plano.</p>
      {loadingPlans ? <p className="muted">Carregando planos...</p> : <div className="grid md:grid-cols-3 gap-4">
        <div className="panel p-8">
          <h3 className="text-2xl font-bold">Gratuito</h3>
          <p className="muted mt-4">2 gerações gratuitas por conta</p>
        </div>
        {plans.map(item => <div className="panel p-8" key={item.id}>
          <h3 className="text-2xl font-bold">{item.name}</h3>
          <p className="text-3xl font-bold mt-5">
            R$ {money(item.price)}
            <span className="muted text-sm font-normal"> / {item.durationDays} dias</span>
          </p>
          <p className="muted mt-4">{item.monthlyCredits} créditos por ciclo</p>
          <button className="btn mt-6 w-full" onClick={() => choosePlan(item)}>Assinar com Pix</button>
        </div>)}
        {!plans.length && <p className="muted md:col-span-3">Não há planos pagos ativos no momento.</p>}
      </div>}
    </section>

    {plan && <div
      className="fixed inset-0 z-50 bg-black/75 p-4 flex items-center justify-center"
      onMouseDown={event => { if (event.target === event.currentTarget) closeDialog(); }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="pix-title" className="panel relative w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 sm:p-8">
        <button type="button" aria-label="Fechar" className="absolute right-4 top-4 p-2" onClick={closeDialog}><X size={20}/></button>
        <h2 id="pix-title" className="text-2xl font-bold pr-8">Plano {charge?.plan.name || plan.name}</h2>
        <p className="muted mt-2">
          R$ {money(charge?.amount ?? plan.price)} · {charge?.plan.durationDays ?? plan.durationDays} dias ·
          {' '}{charge?.plan.monthlyCredits ?? plan.monthlyCredits} créditos após confirmação
        </p>
        {!charge ? <form className="mt-6 space-y-4" onSubmit={createCharge}>
          <label className="block">Nome completo
            <input className="field mt-2" autoComplete="name" required maxLength={120} value={client.name} onChange={event => setClient({ ...client, name: event.target.value })}/>
          </label>
          <label className="block">E-mail
            <input className="field mt-2" type="email" autoComplete="email" required value={client.email} onChange={event => setClient({ ...client, email: event.target.value })}/>
          </label>
          <label className="block">Telefone
            <input className="field mt-2" type="tel" autoComplete="tel" required placeholder="(11) 99999-9999" value={client.phone} onChange={event => setClient({ ...client, phone: event.target.value })}/>
          </label>
          <label className="block">CPF (opcional)
            <input className="field mt-2" inputMode="numeric" autoComplete="off" value={client.document} onChange={event => setClient({ ...client, document: event.target.value })}/>
          </label>
          {message && <p role="alert" className="text-amber-300 text-sm">{message}</p>}
          <button className="btn w-full" disabled={busy}>{busy ? 'Solicitando ao gateway...' : 'Continuar para o Pix'}</button>
          <p className="muted text-xs">A assinatura e os créditos só serão ativados após confirmação autenticada do pagamento.</p>
        </form> : <div className="mt-6 text-center">
          {charge.pix?.code && <div className="inline-flex bg-white p-3 rounded-lg"><QRCodeSVG value={charge.pix.code} size={216} level="M"/></div>}
          <p role="status" className={`font-semibold mt-4 ${charge.status === 'paid' ? 'text-emerald-300' : ''}`}>
            {statusLabel(charge.status)}
          </p>
          {charge.pix?.expiresAt && <p className="muted text-sm mt-1">Expira em {new Date(charge.pix.expiresAt).toLocaleString('pt-BR')}</p>}
          {charge.pix?.code && <>
            <textarea aria-label="Código Pix copia e cola" className="field mt-4 min-h-24 text-xs" readOnly value={charge.pix.code}/>
            <button className="btn mt-3 w-full flex items-center justify-center gap-2" onClick={copyCode}><Copy size={16}/> Copiar código Pix</button>
          </>}
          {charge.status === 'paid' && <p className="text-emerald-300 text-sm mt-4"><Check size={16} className="inline mr-1"/>Pagamento confirmado; os créditos foram atualizados.</p>}
          {pendingStates.has(charge.status) && <p className="muted text-xs mt-4">O status é atualizado após a confirmação do gateway. Não gere outra cobrança enquanto esta estiver pendente.</p>}
          {terminalStates.has(charge.status) && charge.status !== 'paid' && <button className="btn mt-4 w-full" onClick={() => choosePlan(plan)}>Iniciar nova tentativa</button>}
          {message && <p role="status" className="text-amber-300 text-sm mt-3">{message}</p>}
        </div>}
      </section>
    </div>}
  </>;
}
