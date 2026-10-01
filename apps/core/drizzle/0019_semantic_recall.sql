-- Semantic recall: embed durable memory (folded summary items + facts) so a
-- years-long thread can pull back the relevant past instead of dumping the
-- whole summary into every turn. Columns are nullable (backfilled lazily; stay
-- null when no embedding provider is configured). pgvector ships in the DB image.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "summary_items" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

CREATE INDEX IF NOT EXISTS "summary_items_embedding_index" ON "summary_items" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "memories_embedding_index" ON "memories" USING hnsw ("embedding" vector_cosine_ops);
