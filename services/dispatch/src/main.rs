//! TIA dispatch service — Rust + axum + sqlx.
//!
//! Single responsibility: turn an idempotent dispatch request into an external
//! side-effect (write to outbox) + a durable update to the same SQLite the
//! Python pipeline owns. Idempotency-Key is unique in `events`, so a retried
//! request observes the original outcome.
//!
//! Configured by env:
//!   DATABASE_URL   sqlite:///abs/path/to/tia.db   (must match the Python side)
//!   OUTBOX_DIR     /abs/path/to/outbox            (default: ./staging/outbox)
//!   PORT           8001
//!
//! Endpoints:
//!   GET  /health
//!   POST /dispatch/{invoice_id}   header Idempotency-Key required

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteConnectOptions;
use std::{env, fs, path::PathBuf, str::FromStr};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    outbox: PathBuf,
}

#[derive(Deserialize, Default)]
struct DispatchReq {
    by_user: Option<String>,
}

#[derive(Serialize)]
struct DispatchResp {
    status: String,
    idempotency_key: String,
    invoice_id: String,
    outbox_path: String,
    engine: &'static str,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

type ApiResult<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

fn err(code: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrorBody>) {
    (code, Json(ErrorBody { error: msg.into() }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tia_dispatch=info,axum=info".into()),
        )
        .init();

    let db_url =
        env::var("DATABASE_URL").map_err(|_| "DATABASE_URL not set (point at the same SQLite the Python pipeline uses)".to_string())?;
    let outbox = PathBuf::from(env::var("OUTBOX_DIR").unwrap_or_else(|_| "./staging/outbox".into()));
    fs::create_dir_all(&outbox)?;

    // sqlx needs a stripped path for SqliteConnectOptions; accept "sqlite:///abs"
    let path = db_url
        .strip_prefix("sqlite:///")
        .or_else(|| db_url.strip_prefix("sqlite://"))
        .unwrap_or(&db_url);
    let opts = SqliteConnectOptions::from_str(&format!("sqlite:{path}"))?
        .create_if_missing(false);
    let pool = SqlitePool::connect_with(opts).await?;

    let state = AppState {
        pool,
        outbox: outbox.canonicalize().unwrap_or(outbox),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/dispatch/{invoice_id}", post(dispatch))
        .with_state(state);

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8001);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!("tia-dispatch listening on http://127.0.0.1:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok", service: "tia-dispatch" })
}

async fn dispatch(
    State(st): State<AppState>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<DispatchReq>>,
) -> ApiResult<Json<DispatchResp>> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "Idempotency-Key required"))?;
    let by_user = body
        .and_then(|b| b.0.by_user)
        .unwrap_or_else(|| "finops".into());

    // 1) idempotency replay
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM events WHERE idempotency_key = ?1")
            .bind(&key)
            .fetch_optional(&st.pool)
            .await
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if existing.is_some() {
        return Ok(Json(DispatchResp {
            status: "already_dispatched".into(),
            idempotency_key: key,
            invoice_id,
            outbox_path: String::new(),
            engine: "rust",
        }));
    }

    // 2) load invoice
    let inv: Option<(String, f64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, amount, currency, client_code, period FROM invoices WHERE id = ?1",
    )
    .bind(&invoice_id)
    .fetch_optional(&st.pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (inv_id, amount, currency, client_code, period) =
        inv.ok_or_else(|| err(StatusCode::NOT_FOUND, "invoice not found"))?;

    // 3) write outbox file (the external side-effect simulation)
    let outbox_path = st
        .outbox
        .join(format!("dispatch_{}_{}.txt", inv_id, key));
    let body_txt = format!(
        "TIA dispatch (rust)\nInvoice: {inv_id}\nClient: {}\nPeriod: {}\nAmount: {amount:.2} {currency}\nIdempotency-Key: {key}\nDispatched-By: {by_user}\nDispatched-At: {}\n",
        client_code.clone().unwrap_or_default(),
        period.clone().unwrap_or_default(),
        Utc::now().to_rfc3339()
    );
    fs::write(&outbox_path, body_txt)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // 4) invoice + event in one transaction
    let now_iso = Utc::now().to_rfc3339();
    let mut tx = st
        .pool
        .begin()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    sqlx::query(
        "UPDATE invoices SET status = 'dispatched', dispatch_idempotency_key = ?1, dispatch_attempted_at = ?2 WHERE id = ?3",
    )
    .bind(&key)
    .bind(&now_iso)
    .bind(&inv_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let event_id = Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "channel": "rust_outbox",
        "outbox_path": outbox_path.display().to_string(),
        "engine": "rust"
    })
    .to_string();
    sqlx::query(
        "INSERT INTO events (id, actor, entity_kind, entity_id, action, payload, idempotency_key, at) VALUES (?1, ?2, 'invoice', ?3, 'dispatched', ?4, ?5, ?6)",
    )
    .bind(&event_id)
    .bind(&by_user)
    .bind(&inv_id)
    .bind(&payload)
    .bind(&key)
    .bind(&now_iso)
    .execute(&mut *tx)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    tracing::info!(invoice = %inv_id, key = %key, "dispatched");
    Ok(Json(DispatchResp {
        status: "dispatched".into(),
        idempotency_key: key,
        invoice_id: inv_id,
        outbox_path: outbox_path.display().to_string(),
        engine: "rust",
    }))
}
