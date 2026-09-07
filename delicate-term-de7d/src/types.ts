export interface Env {
	PDFS: R2Bucket;
	MEMBERSHIP_CACHE: KVNamespace;
	SUPABASE_URL: string;
	SUPABASE_PROJECT_REF: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	ALLOWED_ORIGIN: string;
	// Stripe — set via `wrangler secret put` in production, `.dev.vars` locally.
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	// Where Stripe Checkout sends the buyer back to. Full URLs on the frontend.
	// MEMBERSHIP_SUCCESS_URL may contain the literal `{CHECKOUT_SESSION_ID}`
	// placeholder, which Stripe substitutes with the real session id.
	MEMBERSHIP_SUCCESS_URL: string;
	MEMBERSHIP_CANCEL_URL: string;
	// JSON object mapping a Stripe price id to the membership it grants:
	//   { "price_abc": { "plan": "full" | "supporting", "edition": "digital" | "print" | null } }
	// `edition: "print"` means the checkout collects a shipping address and a
	// mailing_addresses row is written.
	STRIPE_PRICE_MAP: string;
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
