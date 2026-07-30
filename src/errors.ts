export class ChallengeRequiredError extends Error {
  constructor(message = "ChatGPT requires manual challenge/CAPTCHA resolution") {
    super(message);
    this.name = "ChallengeRequiredError";
  }
}

export class LoginRequiredError extends Error {
  constructor(message = "ChatGPT login is required; run `npm run login` first") {
    super(message);
    this.name = "LoginRequiredError";
  }
}

export class AmbiguousElementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousElementError";
  }
}

export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnTimeoutError";
  }
}
