/**
 * Reusable OpenAPI schema describing the standardized error envelope returned
 * by every endpoint: `{ success, error: { code, message, details? }, timestamp }`.
 */
export const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable, machine readable error code for client-side handling',
          example: 'VALIDATION_ERROR',
        },
        message: {
          type: 'string',
          description: 'Human readable, sanitized error message',
          example: 'The request data is invalid',
        },
        details: {
          type: 'object',
          nullable: true,
          additionalProperties: true,
          description: 'Optional structured context, e.g. field level validation issues',
        },
      },
    },
    timestamp: { type: 'string', format: 'date-time' },
  },
  required: ['success', 'error', 'timestamp'],
} as const;

/**
 * Swagger/OpenAPI Configuration for Dorisio API
 */
export const swaggerConfig = {
  openapi: {
    info: {
      title: 'Dorisio API',
      description:
        'Payment orchestration and creator tipping platform on Stellar.\n\n' +
        'All errors follow a single envelope: `{ success: false, error: { code, message, details? }, timestamp }`. ' +
        'See `docs/ERROR_CODES.md` for the full list of error codes and their HTTP status codes.',
      version: '0.1.0',
      contact: {
        name: 'Dorisio Support',
        url: 'https://dorisio.com',
        email: 'support@dorisio.com',
      },
      license: {
        name: 'MIT',
      },
    },
    servers: [
      {
        url: process.env.API_HOST ? `https://${process.env.API_HOST}` : 'http://localhost:3000',
        description: process.env.NODE_ENV === 'production' ? 'Production' : 'Local development',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http' as const,
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Bearer token for API authentication',
        },
      },
    },
    tags: [
      {
        name: 'Auth',
        description: 'Authentication and wallet operations',
      },
      {
        name: 'Payments',
        description: 'Payment and tip creation',
      },
      {
        name: 'Users',
        description: 'User profile and information',
      },
      {
        name: 'Creators',
        description: 'Creator profile and payout management',
      },
      {
        name: 'Health',
        description: 'System health and status',
      },
    ],
  },
  uiConfig: {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list' as const,
      deepLinking: false,
    },
  },
};
