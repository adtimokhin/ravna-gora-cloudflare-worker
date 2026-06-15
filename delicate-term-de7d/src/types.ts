export interface Env {
  PDFS: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_PROJECT_REF: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGIN: string;
}

export interface Issue {
  id: string;
  issue_number: number;
  issue_date: string;
  slug: string;
  cover_image_url: string | null;
  pdf_object_key: string;
  title: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
}
