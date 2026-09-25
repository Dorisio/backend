/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering only the models
 * the payment service touches. Lets tests exercise real idempotency, refund
 * accounting and audit-trail behaviour without a database.
 */
export class FakePrisma {
  payments: any[] = [];
  refunds: any[] = [];
  events: any[] = [];
  users: any[] = [];
  blacklistedToken = {
    findUnique: async () => null,
    create: async () => ({}),
  };

  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private withRefunds(payment: any, include?: any): any {
    if (!payment) return null;
    return {
      ...payment,
      refunds: include?.refunds ? this.refunds.filter((refund) => refund.paymentId === payment.id) : undefined,
    };
  }

  private matches(payment: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]) => payment[key] === value);
  }

  payment = {
    create: async ({ data, include }: any) => {
      const payment = {
        ...data,
        id: this.nextId('pay'),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.payments.push(payment);
      return this.withRefunds(payment, include);
    },
    findUnique: async ({ where, include }: any) => {
      const payment = this.payments.find((candidate) =>
        where.id !== undefined ? candidate.id === where.id : candidate.idempotencyKey === where.idempotencyKey
      );
      return this.withRefunds(payment, include);
    },
    findFirst: async ({ where }: any) => {
      return this.payments.find((candidate) => this.matches(candidate, where)) ?? null;
    },
    findMany: async ({ where, skip = 0, take = 20, include }: any) => {
      return this.payments
        .filter((payment) => this.matches(payment, where))
        .slice(skip, skip + take)
        .map((payment) => this.withRefunds(payment, include));
    },
    count: async ({ where }: any) => {
      return this.payments.filter((payment) => this.matches(payment, where)).length;
    },
    update: async ({ where, data }: any) => {
      const payment = this.payments.find((candidate) => candidate.id === where.id);
      if (!payment) throw new Error('Payment not found');
      Object.assign(payment, data, { updatedAt: new Date() });
      return payment;
    },
  };

  refund = {
    create: async ({ data }: any) => {
      const refund = {
        ...data,
        id: this.nextId('ref'),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.refunds.push(refund);
      return refund;
    },
    findUnique: async ({ where }: any) => {
      return (
        this.refunds.find((refund) =>
          where.id !== undefined ? refund.id === where.id : refund.idempotencyKey === where.idempotencyKey
        ) ?? null
      );
    },
  };

  paymentEvent = {
    create: async ({ data }: any) => {
      if (
        data.providerEventId &&
        this.events.some((event) => event.providerEventId === data.providerEventId)
      ) {
        const error: any = new Error('Unique constraint failed on the fields: (`providerEventId`)');
        error.code = 'P2002';
        throw error;
      }
      const event = { ...data, id: this.nextId('evt'), createdAt: new Date() };
      this.events.push(event);
      return event;
    },
    findMany: async () => this.events,
  };
}
