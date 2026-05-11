import Redis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
  // eslint-disable-next-line no-var
  var __redisPub: Redis | undefined;
  // eslint-disable-next-line no-var
  var __redisSub: Redis | undefined;
}

function make() {
  return new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
}

export const redis: Redis = global.__redis ?? make();
export const pub: Redis = global.__redisPub ?? make();
export const sub: Redis = global.__redisSub ?? make();
if (!global.__redis) {
  global.__redis = redis;
  global.__redisPub = pub;
  global.__redisSub = sub;
}

export const Channels = {
  drop: (id: string) => `drop:${id}`,
  auction: (id: string) => `auction:${id}`,
  prices: "prices:tick",
} as const;
