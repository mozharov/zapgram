import {z} from 'zod'
import {logger} from '../lib/logger.js'

export function validateData<T>(data: unknown, schema: z.ZodType<T>): T {
  try {
    return schema.parse(data)
  } catch (error) {
    logger.error({error, data}, 'Data validation failed')
    throw new Error('Invalid data format')
  }
}
