// One tiny call per model to check that Structured Outputs, usage fields and the ledger work.
// Run: pnpm probe
import { MODELS, callJson, spentUsd } from './llm.ts';

const schema = {
  name: 'probe',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' }, number: { type: 'integer' } },
    required: ['answer', 'number'],
    additionalProperties: false,
  },
};

for (const model of MODELS) {
  const { data, usage } = await callJson<{ answer: string; number: number }>({
    model,
    system: '짧게 답한다.',
    user: '"민수는 스무 살이다." 이 문장에서 민수의 나이를 숫자로 답하라.',
    schema,
    tag: 'probe',
    reasoning: 'low',
  });
  console.log(model, data, usage);
}
console.log(`spent so far: $${spentUsd().toFixed(5)}`);
