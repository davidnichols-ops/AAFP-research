# Plan B1: Implement aafp-transport-a2a Crate (RFC 0008)

**Priority:** HIGH (highest strategic value)
**Track:** B (Strategic)
**Estimated effort:** 4-6 hours
**Blocked by:** A1 (git should be clean before adding new crate)
**Blocks:** B2 (Python adapter), B3 (extract establish_session)

---

## Objective

Implement the AAFP transport binding for the A2A (Agent2Agent) Protocol per
RFC 0008. This crate carries A2A JSON-RPC 2.0 messages as opaque payloads of
AAFP DATA frames, providing post-quantum secure transport for agent-to-agent
communication.

This is the second transport binding (after MCP, RFC 0007). It proves AAFP
carries more than one application protocol, validating the "secure session
layer" architecture (ADR-0001, ADR-0004).

---

## Design Principles (from ADRs — DO NOT VIOLATE)

1. **Preserve payloads byte-for-byte** (ADR-0002): A2A JSON-RPC messages are
   carried as-is in DATA frames. No transcoding to CBOR. No interpretation.
2. **Use DATA frames, not RPC frames** (ADR-0003): A2A's JSON-RPC is the
   application wire format. AAFP's native RPC frames are for AAFP-internal
   operations only.
3. **AAFP is a session layer** (ADR-0001): This crate does NOT define A2A
   application semantics. It carries A2A messages securely.
4. **Interoperability over replacement** (ADR-0004): This binding lets A2A
   agents use AAFP as a secure transport without changing A2A application logic.

---

## Template: aafp-transport-mcp

This crate mirrors `aafp-transport-mcp` in structure. Before starting, READ
these files completely:

- `implementations/rust/crates/aafp-transport-mcp/Cargo.toml`
- `implementations/rust/crates/aafp-transport-mcp/src/lib.rs` (534 lines — read ALL)
- `implementations/rust/crates/aafp-transport-mcp/tests/integration.rs`
- `implementations/rust/crates/aafp-transport-mcp/tests/conformance.rs`
- `implementations/rust/crates/aafp-transport-mcp/examples/mcp_over_aafp.rs`

Also read:
- `RFCs/0008-a2a-transport-binding.md` (522 lines — the full spec)
- `RFCs/0007-mcp-transport-binding.md` (for comparison)

The A2A binding is structurally identical to the MCP binding. The differences
are: (1) A2A data model types instead of MCP types, (2) A2A method names
(SendMessage, GetTask, etc. instead of tools/list, tools/call), (3) streaming
support via bidirectional streams, (4) no rmcp dependency (A2A has no Rust SDK
equivalent, so we define our own handler trait).

---

## Prerequisites

- A1 complete (git clean)
- Working directory: `/Users/david/projects/AAFP-research/implementations/rust`
- Read all template files listed above
- Read RFC 0008 completely

---

## Steps

### B1.1: Create Cargo.toml

Create `crates/aafp-transport-a2a/Cargo.toml`:

```toml
[package]
name = "aafp-transport-a2a"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "AAFP secure transport binding for the A2A (Agent2Agent) Protocol"

[dependencies]
aafp-core = { workspace = true }
aafp-crypto = { workspace = true }
aafp-identity = { workspace = true }
aafp-messaging = { workspace = true }
aafp-sdk = { workspace = true }
aafp-transport-quic = { workspace = true }
tokio = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
async-trait = { workspace = true }
futures = "0.3"

[dev-dependencies]
tokio = { workspace = true }
anyhow = { workspace = true }
tracing-subscriber = { workspace = true }
tokio-util = { workspace = true }

[features]
default = []
test-utils = []

[[example]]
name = "a2a_over_aafp"
path = "examples/a2a_over_aafp.rs"
```

Note: `futures = "0.3"` is needed for the streaming API (`Stream` trait). Check
if it's already in workspace dependencies; if so, use `{ workspace = true }`.
If not, add it as a direct dependency.

### B1.2: Add to workspace

Edit `Cargo.toml` (workspace root at `implementations/rust/Cargo.toml`):

1. Add to `[workspace] members` list:
   ```toml
   "crates/aafp-transport-a2a",
   ```

2. Add to `[workspace.dependencies]`:
   ```toml
   aafp-transport-a2a = { path = "crates/aafp-transport-a2a" }
   ```

Place it after the `aafp-transport-mcp` line in both sections to maintain
ordering.

### B1.3: Create src/types.rs — A2A data model

Define Rust types for the A2A v1.0 data model. All types use
`#[serde(rename_all = "camelCase")]` to match A2A JSON convention.

Read RFC 0008 §"Data Type Mappings" for the type mapping rules:
- protobuf Message → JSON object (camelCase fields)
- bytes → base64 string
- Timestamp → ISO 8601 string in UTC
- enum → string

Define these types:

```rust
use serde::{Deserialize, Serialize};

// --- Task lifecycle ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub context_id: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<Artifact>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<Message>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,  // ISO 8601 UTC
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    Completed,
    Canceled,
    Failed,
    Unknown,
}

// --- Messages ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,  // "user" or "agent"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<Part>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Part {
    Text(TextPart),
    Data(DataPart),
    File(FilePart),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPart {
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePart {
    pub file: FileWithBytes,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWithBytes {
    pub bytes: String,  // base64
    pub mime_type: String,
    #[serde(rename = "name", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

// --- Artifacts ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parts: Vec<Part>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// --- Streaming events ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub artifact: Artifact,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_chunk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

// --- Push notifications ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNotificationConfig {
    pub url: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authentication: Option<PushNotificationAuthentication>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNotificationAuthentication {
    pub schemes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<serde_json::Value>,
}

// --- Agent Card ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCard {
    pub name: String,
    pub description: Option<String>,
    pub version: String,
    pub url: String,
    pub capabilities: AgentCapabilities,
    pub default_input_modes: Vec<String>,
    pub default_output_modes: Vec<String>,
    pub skills: Vec<AgentSkill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_authenticated_extended_agent_card: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_agent_card: Option<ExtendedAgentCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub streaming: bool,
    pub push_notifications: bool,
    pub state_transition_history: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_input_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_output_modes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedAgentCard {
    pub supported_interfaces: Vec<AgentInterface>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInterface {
    pub url: String,
    pub protocol_binding: String,
    pub protocol_version: String,
}

// --- Task query filter ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}
```

**IMPORTANT:** These types are a starting point based on RFC 0008 and the A2A
v1.0 spec. Verify field names against the actual A2A specification at
https://a2a-protocol.org/v1.0.0/specification/ if possible. The serde
`rename_all = "camelCase"` is critical — A2A uses camelCase JSON fields.

### B1.4: Create src/error.rs — A2A error types

Map the 13 A2A error types from RFC 0008 §"Error Mapping":

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum A2aError {
    #[error("Task not found: {task_id}")]
    TaskNotFound { task_id: String },

    #[error("Task not cancelable: {task_id}")]
    TaskNotCancelable { task_id: String },

    #[error("Push notifications not supported")]
    PushNotificationNotSupported,

    #[error("Unsupported operation: {operation}")]
    UnsupportedOperation { operation: String },

    #[error("Content type not supported: {content_type}")]
    ContentTypeNotSupported { content_type: String },

    #[error("Invalid agent response")]
    InvalidAgentResponse,

    #[error("Extended agent card not configured")]
    ExtendedAgentCardNotConfigured,

    #[error("Extension support required: {extension}")]
    ExtensionSupportRequired { extension: String },

    #[error("Version not supported: {version}")]
    VersionNotSupported { version: String },

    // JSON-RPC standard errors
    #[error("Parse error")]
    ParseError,

    #[error("Invalid request")]
    InvalidRequest,

    #[error("Method not found: {method}")]
    MethodNotFound { method: String },

    #[error("Invalid params")]
    InvalidParams,

    #[error("Internal error: {message}")]
    Internal { message: String },
}

impl A2aError {
    /// Map to JSON-RPC 2.0 error code per RFC 0008 §"Error Mapping"
    pub fn jsonrpc_code(&self) -> i32 {
        match self {
            A2aError::TaskNotFound { .. } => -32001,
            A2aError::TaskNotCancelable { .. } => -32002,
            A2aError::PushNotificationNotSupported => -32003,
            A2aError::UnsupportedOperation { .. } => -32004,
            A2aError::ContentTypeNotSupported { .. } => -32005,
            A2aError::InvalidAgentResponse => -32006,
            A2aError::ExtendedAgentCardNotConfigured => -32007,
            A2aError::ExtensionSupportRequired { .. } => -32008,
            A2aError::VersionNotSupported { .. } => -32009,
            A2aError::ParseError => -32700,
            A2aError::InvalidRequest => -32600,
            A2aError::MethodNotFound { .. } => -32601,
            A2aError::InvalidParams => -32602,
            A2aError::Internal { .. } => -32603,
        }
    }

    /// Convert to a JSON-RPC error response object
    pub fn to_jsonrpc_error(&self, id: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": self.jsonrpc_code(),
                "message": self.to_string(),
            }
        })
    }
}

/// Error type for the AAFP A2A transport
#[derive(Debug, Error)]
pub enum AafpA2aError {
    #[error("AAFP SDK error: {0}")]
    Sdk(#[from] aafp_sdk::SdkError),

    #[error("AAFP frame error: {0}")]
    Framing(String),

    #[error("JSON serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("QUIC I/O error: {0}")]
    Io(#[from] aafp_core::Error),

    #[error("Transport is closed")]
    Closed,

    #[error("Session state error: {0}")]
    Session(String),

    #[error("A2A protocol error: {0}")]
    A2a(#[from] A2aError),
}

impl From<aafp_messaging::FrameError> for AafpA2aError {
    fn from(e: aafp_messaging::FrameError) -> Self {
        AafpA2aError::Framing(e.to_string())
    }
}
```

### B1.5: Create src/lib.rs — Transport struct

This is the core. Mirror `aafp-transport-mcp/src/lib.rs` exactly in structure.
The handshake/auth/session logic is IDENTICAL (copy from aafp-transport-mcp
lines 213-317). The only differences:
- Struct name: `AafpA2aTransport` (not `AafpMcpTransport`)
- Stream ID constant: `A2A_STREAM_ID = 4` (same value, different name)
- Error type: `AafpA2aError` (not `AafpMcpError`)
- No `Transport<R>` trait impl (A2A has no Rust SDK equivalent)
- Module docs reference RFC 0008 instead of RFC 0007

```rust
//! # AAFP Transport for A2A
//!
//! AAFP secure transport binding for the A2A (Agent2Agent) Protocol.
//! Carries A2A JSON-RPC 2.0 messages as payloads of AAFP DATA frames
//! over post-quantum QUIC transport.
//!
//! See RFC 0008 for the full specification.

use std::sync::Arc;
use aafp_core::{AuthorizationProvider, Error as CoreError};
use aafp_crypto::TLS_EXPORTER_LABEL;
use aafp_identity::AgentId;
use aafp_messaging::{encode_frame, Frame, AAFP_VERSION, FRAME_HEADER_SIZE};
use aafp_sdk::{drive_client_handshake, drive_server_handshake, Agent, SdkError};
use aafp_transport_quic::{QuicConnection, QuicRecvStream, QuicSendStream};
use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::Mutex;

mod types;
mod error;
mod server;
mod client;

pub use types::*;
pub use error::*;
pub use server::{A2aServerHandler, dispatch_request};
pub use client::A2aClient;

const A2A_STREAM_ID: u64 = 4;

// ... (copy AafpMcpTransport struct + connect/accept/from_streams/peer_agent_id
//      from aafp-transport-mcp/src/lib.rs, renaming to AafpA2aTransport)
```

Read `aafp-transport-mcp/src/lib.rs` lines 188-365 and replicate with the
renames above. The `extract_tls_binding` helper, `read_data_frame` function,
and `send_data_frame` function are all identical — copy them.

### B1.6: Frame I/O

Copy `read_data_frame` and the send logic from `aafp-transport-mcp/src/lib.rs`.
These are transport-agnostic — they read/write AAFP DATA frames from QUIC
streams. The only thing that changes is the error type (`AafpA2aError` instead
of `AafpMcpError`).

### B1.7: Create src/server.rs — A2A server handler trait

```rust
use async_trait::async_trait;
use std::sync::Arc;
use crate::types::*;
use crate::error::A2aError;

#[async_trait]
pub trait A2aServerHandler: Send + Sync {
    async fn send_message(&self, message: Message) -> Result<Task, A2aError>;
    async fn send_streaming_message(&self, message: Message) -> Result<Vec<TaskUpdateEvent>, A2aError>;
    async fn get_task(&self, task_id: String) -> Result<Task, A2aError>;
    async fn list_tasks(&self, filter: TaskListFilter) -> Result<Vec<Task>, A2aError>;
    async fn cancel_task(&self, task_id: String) -> Result<Task, A2aError>;
    async fn subscribe_to_task(&self, task_id: String) -> Result<Vec<TaskUpdateEvent>, A2aError>;
    async fn create_push_notification_config(&self, task_id: String, config: PushNotificationConfig) -> Result<PushNotificationConfig, A2aError>;
    async fn get_push_notification_config(&self, task_id: String, config_id: String) -> Result<PushNotificationConfig, A2aError>;
    async fn list_push_notification_configs(&self, task_id: String) -> Result<Vec<PushNotificationConfig>, A2aError>;
    async fn delete_push_notification_config(&self, task_id: String, config_id: String) -> Result<(), A2aError>;
    async fn get_extended_agent_card(&self) -> Result<AgentCard, A2aError>;
}

// Define a TaskUpdateEvent enum that wraps both event types:
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum TaskUpdateEvent {
    Status(TaskStatusUpdateEvent),
    Artifact(TaskArtifactUpdateEvent),
}

/// Dispatch a JSON-RPC request to the appropriate handler method.
/// Returns a JSON-RPC response (success or error).
pub async fn dispatch_request(
    handler: &Arc<dyn A2aServerHandler>,
    request: &serde_json::Value,
) -> serde_json::Value {
    // Parse method + params + id from JSON-RPC request
    // Route to handler method
    // Return JSON-RPC response
    // ... (implementation)
}
```

The `dispatch_request` function parses the JSON-RPC method name, calls the
appropriate handler method, and returns a JSON-RPC response. For streaming
methods (`SendStreamingMessage`, `SubscribeToTask`), it returns an array of
events.

### B1.8: Create src/client.rs — A2A client

```rust
use crate::types::*;
use crate::error::{A2aError, AafpA2aError};
use crate::AafpA2aTransport;
use futures::Stream;
use std::pin::Pin;

pub struct A2aClient {
    transport: AafpA2aTransport,
    next_id: u64,
}

impl A2aClient {
    pub async fn connect(agent: &aafp_sdk::Agent, addr: &str) -> Result<Self, AafpA2aError> {
        let transport = AafpA2aTransport::connect(agent, addr).await?;
        Ok(Self { transport, next_id: 1 })
    }

    pub async fn send_message(&mut self, message: Message) -> Result<Task, AafpA2aError> {
        // Serialize JSON-RPC request, send via transport, read response, deserialize
    }

    pub async fn send_streaming_message(&mut self, message: Message) -> Result<Pin<Box<dyn Stream<Item = TaskUpdateEvent> + Send>>, AafpA2aError> {
        // Send request, return a stream that reads events from the transport
    }

    pub async fn get_task(&mut self, task_id: String) -> Result<Task, AafpA2aError> { ... }
    pub async fn list_tasks(&mut self, filter: TaskListFilter) -> Result<Vec<Task>, AafpA2aError> { ... }
    pub async fn cancel_task(&mut self, task_id: String) -> Result<Task, AafpA2aError> { ... }
    pub async fn subscribe_to_task(&mut self, task_id: String) -> Result<Pin<Box<dyn Stream<Item = TaskUpdateEvent> + Send>>, AafpA2aError> { ... }
    pub async fn create_push_notification_config(&mut self, task_id: String, config: PushNotificationConfig) -> Result<PushNotificationConfig, AafpA2aError> { ... }
    pub async fn get_push_notification_config(&mut self, task_id: String, config_id: String) -> Result<PushNotificationConfig, AafpA2aError> { ... }
    pub async fn list_push_notification_configs(&mut self, task_id: String) -> Result<Vec<PushNotificationConfig>, AafpA2aError> { ... }
    pub async fn delete_push_notification_config(&mut self, task_id: String, config_id: String) -> Result<(), AafpA2aError> { ... }
    pub async fn get_extended_agent_card(&mut self) -> Result<AgentCard, AafpA2aError> { ... }
}
```

Each non-streaming method: serialize JSON-RPC request → send DATA frame → read
response DATA frame → deserialize. Use `next_id` for the JSON-RPC `id` field.

Streaming methods: send the request, then return a `Stream` that reads
subsequent DATA frames and deserializes them as `TaskUpdateEvent` until a
`final: true` event is received.

### B1.9: Create tests/integration.rs

Mirror `aafp-transport-mcp/tests/integration.rs`. Tests:

1. **test_send_message**: Client connects, sends a message, receives a Task
   response. Assert task ID and state.
2. **test_get_list_cancel_task**: Client creates a task, gets it, lists tasks,
   cancels it. Assert state transitions.
3. **test_streaming_message**: Client sends a streaming message, receives
   multiple TaskStatusUpdateEvent events on the same stream. Assert events
   arrive in order and the last one has `final: true`.
4. **test_error_mapping**: Client requests a nonexistent task ID. Assert
   JSON-RPC error response with code -32001 (TaskNotFoundError).
5. **test_graceful_close**: Client and server exchange messages, then close
   via AAFP CLOSE frame. Assert clean shutdown.

Use a simple test handler that implements `A2aServerHandler` with in-memory
task storage. Use `tokio::test` macro. Bind to `127.0.0.1:0` (random port).

### B1.10: Create tests/conformance.rs

Protocol-level conformance per INTEROPERABILITY_PLAN.md §4.3 Approach A:

1. **test_jsonrpc_method_names**: Verify method names are PascalCase
   (SendMessage, GetTask, etc.) per A2A v1.0.
2. **test_camelcase_fields**: Verify JSON output uses camelCase field names.
3. **test_byte_preservation**: Send a known JSON-RPC message, capture the
   DATA frame payload, assert it equals the original JSON bytes.
4. **test_all_operations_dispatchable**: Verify all 11 operations can be
   routed through `dispatch_request`.
5. **test_error_codes**: Verify each A2A error type maps to the correct
   JSON-RPC code (-32001 through -32009, -32700, -32600, -32601, -32602, -32603).

### B1.11: Create examples/a2a_over_aafp.rs

A complete agent-to-agent demo:

```rust
// Server agent: implements A2aServerHandler with a simple task processor
// Client agent: connects, sends a message, receives streaming updates, cancels
```

The example should:
1. Start a server agent on `127.0.0.1:0`
2. Connect a client agent
3. Send a message → receive Task
4. Subscribe to task updates → receive streaming events
5. Cancel the task
6. Print all exchanges
7. Graceful close

### B1.12: Update RFC 0008 status

Edit `RFCs/0008-a2a-transport-binding.md`. Change:
```
## Status
Proposed
```
to:
```
## Status
Implemented
```

### B1.13: Update README.md

Edit `README.md`. Find the A2A Transport row in the status table. Change:
```
| A2A Transport | **Designed** (RFC 0006, implementation pending) |
```
to:
```
| A2A Transport | **Implemented** (`aafp-transport-a2a` crate, RFC 0008) |
```

Also update the RFC table if it lists RFC 0008 as "proposed" — change to
"implemented".

### B1.14: Commit

Commit in Rust submodule:
```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-transport-a2a/ Cargo.toml
git commit -m "$(cat <<'EOF'
feat: implement A2A transport binding (RFC 0008)

Adds the aafp-transport-a2a crate, providing post-quantum secure transport
for the A2A (Agent2Agent) Protocol. A2A JSON-RPC 2.0 messages are carried
as opaque payloads of AAFP DATA frames over QUIC.

This is the second transport binding (after MCP, RFC 0007), validating
AAFP's role as a secure session layer for multiple application protocols.

Implements all 11 A2A core operations:
- SendMessage, SendStreamingMessage
- GetTask, ListTasks, CancelTask, SubscribeToTask
- CreateTaskPushNotificationConfig, GetTaskPushNotificationConfig,
  ListTaskPushNotificationConfigs, DeleteTaskPushNotificationConfig
- GetExtendedAgentCard

Includes integration tests, conformance tests, and a full demo example.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella submodule pointer + commit RFC/README changes:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust RFCs/0008-a2a-transport-binding.md README.md
git commit -m "$(cat <<'EOF'
feat: A2A transport binding implemented (RFC 0008)

- Update rust submodule for aafp-transport-a2a crate
- RFC 0008 status: Proposed → Implemented
- README: A2A Transport Designed → Implemented

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### B1.15: Build
```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo build -p aafp-transport-a2a
```
**Expected:** Success, 0 warnings.

### B1.16: Tests
```bash
cargo test -p aafp-transport-a2a
```
**Expected:** All integration + conformance tests pass, 0 failures.

### B1.17: Clippy
```bash
cargo clippy -p aafp-transport-a2a -- -D warnings
```
**Expected:** 0 warnings.

### B1.18: Example
```bash
cargo run --example a2a_over_aafp
```
**Expected:** Demo runs, prints message exchanges, exits cleanly.

---

## Risks & Mitigations

1. **A2A v1.0 spec drift:** The types in B1.3 are based on RFC 0008's summary.
   If the actual A2A spec at a2a-protocol.org has different fields, the types
   need adjustment. **Mitigation:** Add a conformance test that round-trips
   known A2A JSON examples. If you can fetch the spec, verify field names.

2. **Streaming complexity:** The streaming API returns `impl Stream<Item =
   TaskUpdateEvent>`. This requires careful handling of the QUIC stream
   lifecycle — the stream must stay open until `final: true` is received.
   **Mitigation:** Use `tokio::sync::mpsc` channel — spawn a task that reads
   frames and sends events to the channel. The `Stream` wraps the receiver.

3. **No A2A Rust SDK:** Unlike MCP (which has rmcp), A2A has no Rust SDK. We
   define our own `A2aServerHandler` trait and `A2aClient`. This is correct
   per ADR-0001 (AAFP is a session layer, not an application protocol SDK).

4. **Duplicated handshake logic:** This crate copies the handshake/auth logic
   from aafp-transport-mcp. This is intentional and acceptable for now —
   Plan B3 extracts the shared code after this crate lands. Do NOT try to
   extract the abstraction during B1 (premature — get it working first).

5. **`futures` crate dependency:** Check if `futures` is already in the
   workspace dependencies. If not, add it as a direct dependency in this
   crate's Cargo.toml. Prefer `futures = "0.3"` (published 2019, stable).

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark B1.1 through B1.18 as `[x]`
- Set B1 status to `COMPLETE`
