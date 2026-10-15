-- 20261013000000_create_agents_and_audit_logs.sql
-- Setup agents and audit_logs tables with Row-Level Security (RLS) policies ensuring auth.uid() == owner_id

-- 1. Ensure auth schema and auth.uid() helper exist for local PostgreSQL compatibility
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Create updated_at trigger helper
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Create agents table
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  model TEXT DEFAULT 'gpt-4o',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived', 'paused')),
  system_prompt TEXT,
  risk_level TEXT NOT NULL DEFAULT 'Low' CHECK (risk_level IN ('Low', 'Medium', 'High', 'Unacceptable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Create audit_logs table
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  risk_score TEXT NOT NULL CHECK (risk_score IN ('Low', 'Medium', 'High', 'Unacceptable')),
  prompt TEXT,
  response TEXT,
  flagged_pii BOOLEAN NOT NULL DEFAULT false,
  flagged_prompt_injection BOOLEAN NOT NULL DEFAULT false,
  flagged_rogue_tool BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 5. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON public.agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_owner_id ON public.audit_logs(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent_id ON public.audit_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_risk_score ON public.audit_logs(risk_score);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- 6. Trigger for updated_at on agents table
DROP TRIGGER IF EXISTS trigger_agents_updated_at ON public.agents;
CREATE TRIGGER trigger_agents_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 7. Enable and Force Row-Level Security (RLS)
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

-- 8. Ensure standard Supabase roles have table access if roles exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA auth TO authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, anon;
END $$;

-- 9. RLS Policies on agents (auth.uid() == owner_id)
DROP POLICY IF EXISTS "Users can view their own agents" ON public.agents;
CREATE POLICY "Users can view their own agents"
  ON public.agents
  FOR SELECT
  TO authenticated
  USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can create their own agents" ON public.agents;
CREATE POLICY "Users can create their own agents"
  ON public.agents
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can update their own agents" ON public.agents;
CREATE POLICY "Users can update their own agents"
  ON public.agents
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can delete their own agents" ON public.agents;
CREATE POLICY "Users can delete their own agents"
  ON public.agents
  FOR DELETE
  TO authenticated
  USING (auth.uid() = owner_id);

-- 10. RLS Policies on audit_logs (auth.uid() == owner_id)
DROP POLICY IF EXISTS "Users can view their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can view their own audit logs"
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can insert their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can insert their own audit logs"
  ON public.audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can update their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can update their own audit logs"
  ON public.audit_logs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Users can delete their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can delete their own audit logs"
  ON public.audit_logs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = owner_id);
