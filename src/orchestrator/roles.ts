export type ModelRole = "PROPOSER" | "REVIEWER" | "JUDGE";

export interface RoleAssignment {
  providerId: string;
  role: ModelRole;
}

export function assignRoles(
  providers: string[],
  firstProviderId: string,
): RoleAssignment[] {
  return providers.map((id) => ({
    providerId: id,
    role: id === firstProviderId ? "PROPOSER" : "REVIEWER",
  }));
}

export function evaluateDiscrepancy(
  proposalText: string,
  reviewText: string,
): { hasDiscrepancy: boolean; score: number } {
  const normRev = reviewText.toLowerCase();

  const disagreementRegex = /(ошибк|не согласен|неверно|противореч|disagree|error|however)/i;
  const hasDiscrepancy = disagreementRegex.test(normRev);

  return {
    hasDiscrepancy,
    score: hasDiscrepancy ? 0.5 : 1.0,
  };
}
