export const typeDefs = `
  scalar DateTime

  type User {
    id: ID!
    email: String!
    name: String
    role: String!
    verified: Boolean!
    createdAt: DateTime!
  }

  type Creator {
    id: ID!
    username: String!
    displayName: String
    bio: String
    verified: Boolean!
    isPublic: Boolean!
    totalEarnings: Float!
    pendingBalance: Float!
  }

  type Tip {
    id: ID!
    amount: Float!
    message: String
    status: String!
    transactionHash: String
    creatorId: ID!
    fromUserId: ID!
    createdAt: DateTime!
  }

  type QueueHealth {
    name: String!
    waiting: Int!
    active: Int!
    completed: Int!
    failed: Int!
    delayed: Int!
    depth: Int!
  }

  type Query {
    me: User
    creators(limit: Int = 20): [Creator!]!
    creator(username: String!): Creator
    tips(creatorId: ID, limit: Int = 20): [Tip!]!
    tip(id: ID!): Tip
    queueHealth: [QueueHealth!]!
  }

  type Mutation {
    enqueueAnalytics(creatorId: ID!, rangeDays: Int = 30): JobReceipt!
    enqueueExport(type: String!, format: String = "csv"): JobReceipt!
  }

  type JobReceipt {
    id: ID!
    queue: String!
    name: String!
  }
`;
