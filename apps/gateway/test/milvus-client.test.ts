import { describe, it, expect } from 'vitest';
import {
  MilvusClientError,
  SearchParamsSchema,
  InsertParamsSchema,
  MetricTypeSchema,
  HybridSearchParamsSchema,
} from '../src/clients/milvus.js';

describe('Milvus 客户端 Fail-Fast 参数校验', () => {
  it('合法的检索参数通过校验并填充默认值', () => {
    const parsed = SearchParamsSchema.parse({
      collection: 'aics_kb_demo',
      vector: [0.1, 0.2],
      topK: 5,
    });
    expect(parsed.annsField).toBe('vector');
    expect(parsed.topK).toBe(5);
  });

  it('非法集合名被拒绝（fail-fast，不发请求）', () => {
    expect(() =>
      SearchParamsSchema.parse({ collection: 'bad name!', vector: [0.1] }),
    ).toThrow();
  });

  it('topK 超范围被拒绝', () => {
    expect(() =>
      SearchParamsSchema.parse({ collection: 'c', vector: [0.1], topK: 99999 }),
    ).toThrow();
    expect(() =>
      SearchParamsSchema.parse({ collection: 'c', vector: [0.1], topK: 0 }),
    ).toThrow();
  });

  it('非法 metric_type 被拒绝', () => {
    expect(() => MetricTypeSchema.parse('EUCLID')).toThrow();
    expect(MetricTypeSchema.parse('COSINE')).toBe('COSINE');
  });

  it('空向量被拒绝', () => {
    expect(() => SearchParamsSchema.parse({ collection: 'c', vector: [] })).toThrow();
  });

  it('strict 模式拒绝未知字段', () => {
    expect(() =>
      SearchParamsSchema.parse({ collection: 'c', vector: [0.1], evil: true }),
    ).toThrow();
  });

  it('insert 行数上限校验', () => {
    expect(() => InsertParamsSchema.parse({ collection: 'c', rows: [] })).toThrow();
  });

  it('混合检索参数默认值', () => {
    const parsed = HybridSearchParamsSchema.parse({
      collection: 'aics_kb_demo',
      vector: [0.1],
      sparseData: ['查询文本'],
    });
    expect(parsed.rrfK).toBe(60);
    expect(parsed.sparseField).toBe('sparse');
  });

  it('错误类型携带 code', () => {
    const err = new MilvusClientError('timeout', 'MILVUS_TIMEOUT');
    expect(err.code).toBe('MILVUS_TIMEOUT');
    expect(err.name).toBe('MilvusClientError');
  });
});
