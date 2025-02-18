import type {Middleware} from 'koa'

export const requestId: Middleware = async (ctx, next) => {
  ctx.req.id = Math.random().toString(36).substring(2, 10)
  await next()
}
