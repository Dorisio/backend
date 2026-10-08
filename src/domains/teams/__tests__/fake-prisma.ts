/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering the models the
 * team service touches. It implements just enough of the query surface
 * (where/orderBy/skip/take, `in`/`contains`/range operators, aggregates,
 * groupBy, `increment` updates and $transaction) to exercise the real service
 * logic — roles, splits, revenue distribution, payout reservation and the
 * audit trail — without a database.
 */
type Row = Record<string, any>;

const OPERATORS = ['in', 'notIn', 'equals', 'lt', 'lte', 'gt', 'gte', 'not'];

const isPlainObject = (value: any): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const isOperatorObject = (value: any): boolean =>
  isPlainObject(value) && Object.keys(value).some((key) => OPERATORS.includes(key) || key === 'contains');

/** Flattens composite unique keys (`teamId_creatorId: { ... }`) into scalar filters. */
export const expandWhere = (where: Row = {}): Row => {
  const out: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      out[key] = value;
      continue;
    }
    if (isPlainObject(value) && !isOperatorObject(value)) {
      Object.assign(out, value as Row);
      continue;
    }
    out[key] = value;
  }
  return out;
};

export const matchesValue = (actual: any, expected: any): boolean => {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (expected instanceof Date) {
    return actual instanceof Date ? actual.getTime() === expected.getTime() : actual === expected.toISOString();
  }
  if (Array.isArray(expected)) {
    return expected.includes(actual);
  }
  if (isPlainObject(expected)) {
    if ('in' in expected) return (expected.in as any[]).some((value) => matchesValue(actual, value));
    if ('notIn' in expected) return !(expected.notIn as any[]).some((value) => matchesValue(actual, value));
    if ('contains' in expected) {
      return String(actual ?? '')
        .toLowerCase()
        .includes(String(expected.contains).toLowerCase());
    }
    if ('gte' in expected) return actual >= expected.gte;
    if ('gt' in expected) return actual > expected.gt;
    if ('lte' in expected) return actual <= expected.lte;
    if ('lt' in expected) return actual < expected.lt;
    if ('not' in expected) return !matchesValue(actual, expected.not);
    // Nested/related filter, e.g. { team: { name: { contains: 'x' } } }
    return Object.entries(expected).every(([key, value]) => matchesValue(actual?.[key], value));
  }
  return actual === expected;
};

export const matches = (row: Row, where: Row = {}): boolean => {
  for (const [key, value] of Object.entries(expandWhere(where))) {
    if (key === 'OR') {
      if (!(value as Row[]).some((candidate) => matches(row, candidate))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(Array.isArray(value) ? value : [value]).every((candidate) => matches(row, candidate))) return false;
      continue;
    }
    if (key === 'NOT') {
      const candidates = Array.isArray(value) ? value : [value];
      if (candidates.some((candidate) => matches(row, candidate))) return false;
      continue;
    }
    if (!matchesValue(row[key], value)) return false;
  }
  return true;
};

const compareRows = (a: Row, b: Row, orderBy: any): number => {
  const entries = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  for (const entry of entries) {
    for (const [field, direction] of Object.entries(entry)) {
      const left = a[field] instanceof Date ? a[field].getTime() : a[field];
      const right = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (left === right) continue;
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      const result = left < right ? -1 : 1;
      return (direction as string) === 'desc' ? -result : result;
    }
  }
  return 0;
};

class Table {
  rows: Row[] = [];
  private sequence = 0;

  constructor(
    private prefix: string,
    private hydrate?: (row: Row, table: Table) => Row,
    /** Column defaults the database would apply, so reads match production. */
    private defaults: Row = {}
  ) {}

  private view(row: Row): Row {
    if (!row) return row;
    return this.hydrate ? this.hydrate(row, this) : row;
  }

  private store(data: Row): Row {
    this.sequence += 1;
    const row: Row = {
      ...this.defaults,
      ...data,
      id: data.id ?? `${this.prefix}_${this.sequence}`,
      createdAt: data.createdAt ?? new Date(),
      updatedAt: data.updatedAt ?? new Date(),
    };
    this.rows.push(row);
    return row;
  }

  private applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (isPlainObject(value) && 'increment' in value) {
        row[key] = (row[key] ?? 0) + value.increment;
        continue;
      }
      if (isPlainObject(value) && 'decrement' in value) {
        row[key] = (row[key] ?? 0) - value.decrement;
        continue;
      }
      if (isPlainObject(value) && 'set' in value) {
        row[key] = value.set;
        continue;
      }
      row[key] = value;
    }
    row.updatedAt = new Date();
  }

  private filtered(where?: Row): Row[] {
    return this.rows.filter((row) => matches(row, where));
  }

  /** Returns the hydrated view of a row (for relations). */
  find(id: string): Row | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? this.view(row) : null;
  }

  create = async ({ data }: any): Promise<Row> => this.view(this.store(data));

  createMany = async ({ data }: any): Promise<{ count: number }> => {
    const items: Row[] = Array.isArray(data) ? data : [data];
    for (const item of items) this.store(item);
    return { count: items.length };
  };

  findUnique = async ({ where }: any): Promise<Row | null> => {
    const expanded = expandWhere(where);
    const row = this.rows.find((candidate) => matches(candidate, expanded));
    return row ? this.view(row) : null;
  };

  findFirst = async ({ where, orderBy }: any = {}): Promise<Row | null> => {
    const results = this.filtered(where).sort((a, b) => compareRows(a, b, orderBy));
    return results.length > 0 ? this.view(results[0]) : null;
  };

  findMany = async ({ where, orderBy, skip = 0, take }: any = {}): Promise<Row[]> => {
    const results = this.filtered(where).sort((a, b) => compareRows(a, b, orderBy));
    const paged = take === undefined ? results.slice(skip) : results.slice(skip, skip + take);
    return paged.map((row) => this.view(row));
  };

  count = async ({ where }: any = {}): Promise<number> => this.filtered(where).length;

  update = async ({ where, data }: any): Promise<Row> => {
    const row = this.rows.find((candidate) => matches(candidate, expandWhere(where)));
    if (!row) throw new Error(`Record to update not found: ${JSON.stringify(where)}`);
    this.applyData(row, data);
    return this.view(row);
  };

  updateMany = async ({ where, data }: any): Promise<{ count: number }> => {
    const rows = this.filtered(where);
    for (const row of rows) this.applyData(row, data);
    return { count: rows.length };
  };

  upsert = async ({ where, create, update }: any): Promise<Row> => {
    const row = this.rows.find((candidate) => matches(candidate, expandWhere(where)));
    if (!row) return this.view(this.store({ ...expandWhere(where), ...create }));
    this.applyData(row, update);
    return this.view(row);
  };

  aggregate = async ({ where, _sum, _count }: any = {}): Promise<Row> => {
    const rows = this.filtered(where);
    const result: Row = {};
    if (_sum) {
      result._sum = {};
      for (const field of Object.keys(_sum)) {
        if (_sum[field]) {
          result._sum[field] = rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
        }
      }
    }
    if (_count !== undefined) {
      result._count = typeof _count === 'object' ? { ..._count } : rows.length;
      if (typeof _count === 'object') {
        result._count = rows.length;
      }
    }
    return result;
  };

  groupBy = async ({ by, where, _sum, _count }: any = {}): Promise<Row[]> => {
    const rows = this.filtered(where);
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = (by as string[]).map((field) => String(row[field])).join('|');
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    return [...groups.values()].map((bucket) => {
      const result: Row = {};
      for (const field of by as string[]) result[field] = bucket[0][field];
      if (_sum) {
        result._sum = {};
        for (const field of Object.keys(_sum)) {
          if (_sum[field]) {
            result._sum[field] = bucket.reduce((total, row) => total + (Number(row[field]) || 0), 0);
          }
        }
      }
      if (_count !== undefined) result._count = bucket.length;
      return result;
    });
  };
}

export class FakePrisma {
  creator = new Table('creator');
  user = new Table('user', (row) => ({
    ...row,
    creator: this.creator.rows.find((candidate) => candidate.userId === row.id) ?? null,
  }));

  creatorTeam = new Table('team', undefined, {
    verified: false,
    isPublic: true,
    payoutMode: 'team',
    payoutWalletAddress: null,
    payoutWalletVerified: false,
    pendingBalance: 0,
    reservedBalance: 0,
    totalEarnings: 0,
  });

  teamRevenueSplit = new Table('split');

  creatorTeamMember = new Table(
    'member',
    (row) => ({
      ...row,
      creator: this.creator.rows.find((candidate) => candidate.id === row.creatorId) ?? null,
      team: this.creatorTeam.rows.find((candidate) => candidate.id === row.teamId) ?? null,
      splits: this.teamRevenueSplit.rows.filter((split) => split.memberId === row.id),
    }),
    { role: 'member', status: 'active', contributionCount: 0, contributionAmount: 0 }
  );

  teamContribution = new Table('contribution', (row) => ({
    ...row,
    member: this.creatorTeamMember.find(row.memberId),
  }));

  teamRevenueDistribution = new Table('distribution');

  teamRevenueShare = new Table('share');

  teamPayout = new Table('teamPayout');

  teamAuditLog = new Table('audit');

  tip = new Table('tip');

  $transaction = async (callback: (tx: FakePrisma) => Promise<unknown>): Promise<any> => callback(this);

  $disconnect = async (): Promise<void> => undefined;
}
