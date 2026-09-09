import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE = 'dsh-kanban'
export const SERVICE = 'kanban'

function fail(message) {
  throw new Error(`${PACKAGE} remote: ${message}`)
}

function parseJsonValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry, index) => parseJsonValue(entry, `${label}[${index}]`))
  if (typeof value === 'object') {
    const copy = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) copy[key] = parseJsonValue(entry, `${label}.${key}`)
    }
    return copy
  }
  fail(`${label} must be JSON data`)
}

function parseJsonObject(value, label) {
  const parsed = parseJsonValue(value, label)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} must be an object`)
  return parsed
}

function codec(typeSymbol, parse) {
  return Object.freeze({ mode: 'strict', typeSymbol, schema: Object.freeze({ _zod: {}, parse }) })
}

const MethodCodec = codec(`${PACKAGE}/Method`, (value) => {
  if (typeof value !== 'string' || value === '') fail('method must be a non-empty string')
  return value
})
const ArgsCodec = codec(`${PACKAGE}/Args`, (value) => parseJsonObject(value, 'args'))
const ResultCodec = codec(`${PACKAGE}/Result`, (value) => parseJsonObject(value, 'result'))

function param(name, valueCodec) {
  return { name, wire: name, source: 'json', codec: valueCodec }
}

const callInvocation = {
  id: `${PACKAGE}#${SERVICE}/call`,
  service: SERVICE,
  namespace: SERVICE,
  method: 'call',
  invocation: { kind: 'direct' },
  parameters: [param('method', MethodCodec), param('args', ArgsCodec)],
  result: ResultCodec,
}

export const TYPERT = Object.freeze({
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [callInvocation],
  model: { services: [], events: [], objects: [] },
})

export const TYPERT_REMOTE = Object.freeze({
  package: PACKAGE,
  descriptors: [callInvocation],
})

export function createKanbanController(handlers) {
  return {
    async call(method, args) {
      const handler = handlers.get(method)
      if (handler === undefined) throw new Error(`${PACKAGE}: unknown Host method ${method}`)
      return handler(args)
    },
  }
}

const remoteInitializers = []

export class KanbanGateway extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, SERVICE)
    this.controller = controller
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  call(method, args) {
    return this.controller.call(method, args)
  }
}

Remote('call')(KanbanGateway.prototype.call, {
  kind: 'method',
  name: 'call',
  static: false,
  private: false,
  addInitializer(initializer) {
    remoteInitializers.push(initializer)
  },
})
