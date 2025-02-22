import type {ChatJoinRequest} from 'grammy/types'
import type {BaseContext} from '../context.js'
import type {ChatTypeContext} from 'grammy'

type Context = ChatTypeContext<BaseContext, 'supergroup' | 'channel'> & {
  chatJoinRequest: ChatJoinRequest
}

export const chatJoinRequestHandler = async (ctx: Context) => {
  await ctx.api
    .sendMessage(ctx.chatJoinRequest.user_chat_id, 'You are welcome!')
    .catch((error: unknown) => {
      ctx.log.error({error}, 'Error while sending message to user about chat join request')
    })
}
