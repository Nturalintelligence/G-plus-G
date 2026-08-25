const VERIFY_MARKER_PATTERN = /(?<![A-Za-z0-9_-])S0-(\d{10,16})-(\d{1,3})(?![A-Za-z0-9_-])/g;

export class VerificationMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationMarkerError";
  }
}

export function extractExpectedVerificationMarker(response: string, expectedMarker: string): string {
  const expected = /^S0-(\d{10,16})-(\d{1,3})$/.exec(expectedMarker);
  if (!expected) throw new VerificationMarkerError("Некорректный ожидаемый служебный маркер");

  const markers = [...response.matchAll(VERIFY_MARKER_PATTERN)].map((match) => match[0]);
  if (markers.length === 0) {
    throw new VerificationMarkerError("Ответ не содержит ожидаемый служебный маркер");
  }

  const distinct = [...new Set(markers)];
  if (distinct.length > 1) {
    throw new VerificationMarkerError("Ответ содержит несколько конфликтующих служебных маркеров");
  }
  if (distinct[0] !== expectedMarker) {
    throw new VerificationMarkerError("Служебный маркер относится к другому запуску или шагу");
  }
  return expectedMarker;
}
