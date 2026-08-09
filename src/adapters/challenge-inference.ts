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
    isGoogleTrafficBlockUrl(url) ||
    url.includes("/challenge/")
  ) {
    return true;
  }
  return /^(just a moment|attention required|captcha|verify you are human|one moment|один момент|подтвердите,? что вы человек)$/i.test(
    input.title.trim(),
  );
}

export function isGoogleTrafficBlockUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "google.com" || parsed.hostname.endsWith(".google.com")) &&
      parsed.pathname.startsWith("/sorry/")
    );
  } catch {
    return false;
  }
}
