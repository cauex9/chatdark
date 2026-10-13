type Props = {
  credits: number | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  onRetry: () => void;
  onViewPlans: () => void;
  compact?: boolean;
};

export default function CreditsBalance({
  credits,
  status,
  error,
  onRetry,
  onViewPlans,
  compact = false,
}: Props) {
  if (status === 'loading' || status === 'idle') {
    return <span className="muted text-sm whitespace-nowrap">Carregando créditos...</span>;
  }

  if (status === 'error') {
    return (
      <span className="flex items-center gap-2 text-amber-300 text-sm">
        <span title={error}>Não foi possível carregar créditos</span>
        <button type="button" className="underline" onClick={onRetry}>Tentar novamente</button>
      </span>
    );
  }

  if (credits === null) {
    return <span className="text-amber-300 text-sm">Saldo indisponível</span>;
  }

  return (
    <span className={`flex items-center gap-2 text-sm whitespace-nowrap ${compact ? '' : 'flex-wrap'}`}>
      <span className="muted">{credits} {credits === 1 ? 'crédito' : 'créditos'}</span>
      {credits === 0 && (
        <button type="button" className="text-lime-300 underline" onClick={onViewPlans}>Ver planos</button>
      )}
    </span>
  );
}
