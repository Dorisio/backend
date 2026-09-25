import { ErrorCodes } from '../utils/errors';

/**
 * Minimal i18n layer for API error messages.
 *
 * Only framework-level, generic messages are translated. Domain specific
 * messages (for example "Cannot tip yourself") are always returned as-is so
 * that reviewers and clients never lose context. English is the default and
 * fallback locale.
 */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'pt'] as const;

export type ErrorLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: ErrorLocale = 'en';

type Catalog = Record<string, string>;

const en: Catalog = {
  [ErrorCodes.VALIDATION_ERROR]: 'The request data is invalid',
  [ErrorCodes.BAD_REQUEST]: 'Bad request',
  [ErrorCodes.UNAUTHORIZED]: 'Authentication is required',
  [ErrorCodes.FORBIDDEN]: 'You do not have permission to perform this action',
  [ErrorCodes.NOT_FOUND]: 'The requested resource was not found',
  [ErrorCodes.CONFLICT]: 'The request conflicts with the current state of the resource',
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'Too many requests, please try again later',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'The request payload is too large',
  [ErrorCodes.INTERNAL_ERROR]: 'An unexpected error occurred',
  [ErrorCodes.DATABASE_ERROR]: 'A database error occurred',
  [ErrorCodes.DATABASE_UNAVAILABLE]: 'The service is temporarily unavailable',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 'An upstream service failed to process the request',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable',
};

const es: Catalog = {
  [ErrorCodes.VALIDATION_ERROR]: 'Los datos de la solicitud no son válidos',
  [ErrorCodes.BAD_REQUEST]: 'Solicitud incorrecta',
  [ErrorCodes.UNAUTHORIZED]: 'Se requiere autenticación',
  [ErrorCodes.FORBIDDEN]: 'No tienes permiso para realizar esta acción',
  [ErrorCodes.NOT_FOUND]: 'No se encontró el recurso solicitado',
  [ErrorCodes.CONFLICT]: 'La solicitud entra en conflicto con el estado actual del recurso',
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'Demasiadas solicitudes, inténtalo de nuevo más tarde',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'El cuerpo de la solicitud es demasiado grande',
  [ErrorCodes.INTERNAL_ERROR]: 'Se produjo un error inesperado',
  [ErrorCodes.DATABASE_ERROR]: 'Se produjo un error en la base de datos',
  [ErrorCodes.DATABASE_UNAVAILABLE]: 'El servicio no está disponible temporalmente',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 'Un servicio externo no pudo procesar la solicitud',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'El servicio no está disponible temporalmente',
};

const fr: Catalog = {
  [ErrorCodes.VALIDATION_ERROR]: 'Les données de la requête sont invalides',
  [ErrorCodes.BAD_REQUEST]: 'Requête incorrecte',
  [ErrorCodes.UNAUTHORIZED]: 'Authentification requise',
  [ErrorCodes.FORBIDDEN]: "Vous n'êtes pas autorisé à effectuer cette action",
  [ErrorCodes.NOT_FOUND]: 'La ressource demandée est introuvable',
  [ErrorCodes.CONFLICT]: "La requête entre en conflit avec l'état actuel de la ressource",
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'Trop de requêtes, veuillez réessayer plus tard',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'La requête est trop volumineuse',
  [ErrorCodes.INTERNAL_ERROR]: "Une erreur inattendue s'est produite",
  [ErrorCodes.DATABASE_ERROR]: "Une erreur de base de données s'est produite",
  [ErrorCodes.DATABASE_UNAVAILABLE]: 'Le service est temporairement indisponible',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: "Un service externe n'a pas pu traiter la requête",
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'Le service est temporairement indisponible',
};

const pt: Catalog = {
  [ErrorCodes.VALIDATION_ERROR]: 'Os dados da requisição são inválidos',
  [ErrorCodes.BAD_REQUEST]: 'Requisição inválida',
  [ErrorCodes.UNAUTHORIZED]: 'Autenticação necessária',
  [ErrorCodes.FORBIDDEN]: 'Você não tem permissão para executar esta ação',
  [ErrorCodes.NOT_FOUND]: 'O recurso solicitado não foi encontrado',
  [ErrorCodes.CONFLICT]: 'A requisição conflita com o estado atual do recurso',
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'Muitas requisições, tente novamente mais tarde',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'O corpo da requisição é muito grande',
  [ErrorCodes.INTERNAL_ERROR]: 'Ocorreu um erro inesperado',
  [ErrorCodes.DATABASE_ERROR]: 'Ocorreu um erro no banco de dados',
  [ErrorCodes.DATABASE_UNAVAILABLE]: 'O serviço está temporariamente indisponível',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 'Um serviço externo falhou ao processar a requisição',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'O serviço está temporariamente indisponível',
};

const CATALOG: Record<ErrorLocale, Catalog> = { en, es, fr, pt };

export function getCatalog(locale: ErrorLocale): Catalog {
  return CATALOG[locale] ?? CATALOG[DEFAULT_LOCALE];
}

/**
 * Resolves a locale from an Accept-Language header, honouring quality weights.
 * Falls back to English when the header is missing or unsupported.
 */
export function resolveLocale(acceptLanguage?: string | string[] | null): ErrorLocale {
  if (!acceptLanguage) {
    return DEFAULT_LOCALE;
  }

  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage;

  const candidates = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.split('=')[1]) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((c) => c.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    // Match exact tag, then the primary subtag (e.g. `pt-BR` -> `pt`).
    const primary = tag.split('-')[0];
    if ((SUPPORTED_LOCALES as readonly string[]).includes(tag)) {
      return tag as ErrorLocale;
    }
    if ((SUPPORTED_LOCALES as readonly string[]).includes(primary)) {
      return primary as ErrorLocale;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Returns a localized message for `code`, or the provided fallback when the
 * code is not part of the generic catalog (domain specific messages must not be
 * replaced).
 */
export function translateError(
  code: string,
  locale: ErrorLocale,
  fallback?: string
): string | undefined {
  const catalog = getCatalog(locale);
  const translated = catalog[code];
  if (!translated) {
    // No translation for this code — keep the original message untouched.
    return fallback;
  }
  return translated;
}
