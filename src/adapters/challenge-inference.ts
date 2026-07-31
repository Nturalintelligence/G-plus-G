export function inferChallengePage(input: {
  url: string;
  title: string;
  structuralSignals: number;
}): boolean {
  if (input.structuralSignals > 0) return true;
  const url = input.url.toLowerCase();
  if (
    url.includes("/cdn-cgi/challenge") ||
    url.includes("challenges.cloudflare.com") ||
    url.includes("/sorry/") ||
    url.includes("/challenge/")
  ) {
    return true;
  }
  return /^(just a moment|attention required|captcha|verify you are human|one moment|один момент|подтвердите,? что вы человек)$/i.test(
    input.title.trim(),
  );
}
