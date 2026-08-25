export interface ComposerCandidateState {
  visible: boolean;
  editable: boolean;
  enabled: boolean;
  active: boolean;
  bottom: number;
}

export function selectComposerIndex(candidates: readonly ComposerCandidateState[]): number | null {
  const usable = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.visible && candidate.editable && candidate.enabled);
  if (usable.length === 0) return null;
  const active = usable.filter(({ candidate }) => candidate.active);
  const pool = active.length > 0 ? active : usable;
  return pool.reduce((best, item) => item.candidate.bottom >= best.candidate.bottom ? item : best).index;
}
