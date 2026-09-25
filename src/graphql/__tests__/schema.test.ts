import { describe, it, expect } from 'vitest';
import { typeDefs } from '../schema';

describe('GraphQL schema (Issue #30)', () => {
  it('defines core types and operations', () => {
    expect(typeDefs).toContain('type User');
    expect(typeDefs).toContain('type Creator');
    expect(typeDefs).toContain('type Tip');
    expect(typeDefs).toContain('type Query');
    expect(typeDefs).toContain('type Mutation');
    expect(typeDefs).toContain('creators');
    expect(typeDefs).toContain('enqueueAnalytics');
  });
});
