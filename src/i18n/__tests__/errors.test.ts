import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCALE, resolveLocale, translateError } from '../errors';
import { ErrorCodes } from '../../utils/errors';

describe('error i18n', () => {
  describe('resolveLocale', () => {
    it('defaults to English when no header is provided', () => {
      expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
      expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
      expect(resolveLocale('')).toBe(DEFAULT_LOCALE);
    });

    it('resolves a supported language tag', () => {
      expect(resolveLocale('es')).toBe('es');
      expect(resolveLocale('fr-FR')).toBe('fr');
      expect(resolveLocale('pt-BR,pt;q=0.9')).toBe('pt');
    });

    it('honours quality weights', () => {
      expect(resolveLocale('de;q=0.8,es;q=0.9')).toBe('es');
    });

    it('falls back to English for unsupported languages', () => {
      expect(resolveLocale('de-DE,de;q=0.9')).toBe(DEFAULT_LOCALE);
    });

    it('accepts an array of header values', () => {
      expect(resolveLocale(['fr-CA', 'en;q=0.5'])).toBe('fr');
    });
  });

  describe('translateError', () => {
    it('translates known generic codes', () => {
      expect(translateError(ErrorCodes.VALIDATION_ERROR, 'es')).toBe(
        'Los datos de la solicitud no son válidos'
      );
    });

    it('returns the fallback for unknown domain codes', () => {
      expect(translateError('CREATOR_NOT_FOUND', 'es', 'Creator not found')).toBe(
        'Creator not found'
      );
    });

    it('returns undefined when there is no translation and no fallback', () => {
      expect(translateError('CREATOR_NOT_FOUND', 'es')).toBeUndefined();
    });
  });
});
