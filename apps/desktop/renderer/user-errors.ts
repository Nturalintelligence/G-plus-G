export interface UserFacingAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}

export interface UserFacingError {
  code: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  actions?: UserFacingAction[];
  detailsRef?: string;
  rawStack?: string;
}

export function toUserFacingError(error: unknown, context?: string): UserFacingError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack : undefined;

  if (rawMessage.includes("Another provider operation is already active")) {
    return {
      code: "AUTH_OPERATION_ACTIVE",
      severity: "warning",
      title: "Авторизация уже выполняется",
      message: "Операция входа или проверки сессии уже запущена. Пожалуйста, дождитесь открытия или завершения окна авторизации.",
      rawStack,
    };
  }

  if (rawMessage.includes("CHALLENGE_REQUIRED")) {
    return {
      code: "CHALLENGE_REQUIRED",
      severity: "warning",
      title: "Требуется авторизация провайдера",
      message: "Браузерная сессия требует входа или прохождения проверки капчи. Откройте Настройки и нажмите «Войти в аккаунт».",
      rawStack,
    };
  }

  if (rawMessage.includes("Target page, context or browser has been closed")) {
    return {
      code: "BROWSER_CLOSED",
      severity: "info",
      title: "Окно авторизации закрыто",
      message: "Окно браузера было закрыто до завершения входа. Повторите попытку при необходимости.",
      rawStack,
    };
  }

  // General user error fallback
  return {
    code: "GENERAL_ERROR",
    severity: "error",
    title: context ? `Ошибка: ${context}` : "Произошла ошибка",
    message: rawMessage.replace(/Error invoking remote method '[^']+': Error: /, "").replace(/Диагностика: .*/, "").trim(),
    rawStack,
  };
}
