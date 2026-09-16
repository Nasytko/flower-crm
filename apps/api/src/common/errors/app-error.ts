export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorResponseBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}
