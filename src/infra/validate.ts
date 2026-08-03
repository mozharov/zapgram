import type {ZodType} from 'zod'

export function validateData<T>(data: unknown, schema: ZodType<T>): T {
  try {
    return schema.parse(data)
  } catch (error) {
    throw new Error('Invalid data format', {cause: error})
  }
}
