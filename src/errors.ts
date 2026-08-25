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

export class LoginCancelledError extends Error {
  constructor(message = "Пользователь закрыл окно до завершения входа") {
    super(message);
    this.name = "LoginCancelledError";
  }
}

export class LoginTimeoutError extends Error {
  constructor(message = "Время ожидания входа истекло") {
    super(message);
    this.name = "LoginTimeoutError";
  }
}

export class ConversationUnavailableError extends Error {
  constructor(message = "Сохранённый веб-диалог удалён или недоступен") {
    super(message);
    this.name = "ConversationUnavailableError";
  }
}
