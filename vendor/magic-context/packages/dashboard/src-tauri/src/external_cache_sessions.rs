use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct JsonlSessionMeta {
    pub session_id: String,
    pub jsonl_path: PathBuf,
    pub cwd: String,
    pub created: i64,
    pub modified: i64,
    pub event_count: u32,
    pub(crate) source_mtime: SystemTime,
}

#[derive(Debug, Clone)]
pub struct JsonlCacheEvent {
    pub message_id: String,
    pub session_id: String,
    pub timestamp_ms: i64,
    pub input_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub model: Option<String>,
    pub finish: Option<String>,
    pub context_limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct JsonlSessionDetail {
    pub meta: JsonlSessionMeta,
    pub events: Vec<JsonlCacheEvent>,
}

// Remember files with no usable cache events too, so an unchanged JSONL file
// is not reparsed on every dashboard refresh.
type MetaCache = HashMap<PathBuf, (SystemTime, Option<Arc<JsonlSessionMeta>>)>;
type DetailCache = HashMap<PathBuf, (SystemTime, Option<Arc<JsonlSessionDetail>>)>;
type DirectoryListingCache = HashMap<PathBuf, CachedDirectoryListing>;

#[derive(Debug)]
struct CachedDirectoryListing {
    scanned_at: Instant,
    files: Arc<Vec<ScannedJsonlFile>>,
}

#[derive(Debug, Clone)]
struct ScannedJsonlFile {
    path: PathBuf,
    mtime: SystemTime,
}

const DIRECTORY_LISTING_TTL: Duration = Duration::from_secs(5);
const SOURCE_MTIME_CLOCK_SKEW_MS: i64 = 2_000;

static CLAUDE_META_CACHE: OnceLock<RwLock<MetaCache>> = OnceLock::new();
static CLAUDE_DETAIL_CACHE: OnceLock<RwLock<DetailCache>> = OnceLock::new();
static CLAUDE_DIRECTORY_LISTING_CACHE: OnceLock<RwLock<DirectoryListingCache>> = OnceLock::new();
static CLAUDE_TEST_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static CODEX_META_CACHE: OnceLock<RwLock<MetaCache>> = OnceLock::new();
static CODEX_DETAIL_CACHE: OnceLock<RwLock<DetailCache>> = OnceLock::new();
static CODEX_DIRECTORY_LISTING_CACHE: OnceLock<RwLock<DirectoryListingCache>> = OnceLock::new();
static CODEX_TEST_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn claude_meta_cache() -> &'static RwLock<MetaCache> {
    CLAUDE_META_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn claude_detail_cache() -> &'static RwLock<DetailCache> {
    CLAUDE_DETAIL_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn claude_directory_listing_cache() -> &'static RwLock<DirectoryListingCache> {
    CLAUDE_DIRECTORY_LISTING_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn claude_test_root() -> &'static RwLock<Option<PathBuf>> {
    CLAUDE_TEST_ROOT.get_or_init(|| RwLock::new(None))
}

fn codex_meta_cache() -> &'static RwLock<MetaCache> {
    CODEX_META_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn codex_detail_cache() -> &'static RwLock<DetailCache> {
    CODEX_DETAIL_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn codex_directory_listing_cache() -> &'static RwLock<DirectoryListingCache> {
    CODEX_DIRECTORY_LISTING_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn codex_test_root() -> &'static RwLock<Option<PathBuf>> {
    CODEX_TEST_ROOT.get_or_init(|| RwLock::new(None))
}

pub fn claude_code_sessions_root() -> Option<PathBuf> {
    if let Ok(root) = claude_test_root().read() {
        if let Some(path) = root.clone() {
            return Some(path);
        }
    }
    Some(dirs::home_dir()?.join(".claude/projects"))
}

pub fn codex_sessions_root() -> Option<PathBuf> {
    if let Ok(root) = codex_test_root().read() {
        if let Some(path) = root.clone() {
            return Some(path);
        }
    }
    Some(dirs::home_dir()?.join(".codex/sessions"))
}

pub fn scan_claude_code_session_dir() -> Vec<JsonlSessionMeta> {
    let Some(root) = claude_code_sessions_root() else {
        return Vec::new();
    };
    scan_claude_code_session_dir_at(&root)
}

pub fn scan_claude_code_session_dir_at(root: &Path) -> Vec<JsonlSessionMeta> {
    let files = cached_jsonl_files(root, claude_directory_listing_cache());
    files
        .iter()
        .filter_map(|file| {
            read_cached_meta_at_mtime(
                &file.path,
                file.mtime,
                claude_meta_cache(),
                read_claude_code_session_meta_uncached,
            )
        })
        .collect::<Vec<_>>()
        .tap_sort_newest_first()
}

pub fn read_claude_code_session_meta(path: &Path) -> Option<JsonlSessionMeta> {
    read_cached_meta(
        path,
        claude_meta_cache(),
        read_claude_code_session_meta_uncached,
    )
}

pub fn read_claude_code_session_detail(path: &Path) -> Option<Arc<JsonlSessionDetail>> {
    read_cached_detail(
        path,
        claude_detail_cache(),
        read_claude_code_session_detail_uncached,
    )
}

pub fn find_claude_code_session_meta(session_id: &str) -> Option<JsonlSessionMeta> {
    scan_claude_code_session_dir()
        .into_iter()
        .find(|meta| meta.session_id == session_id)
}

pub fn find_claude_code_session_path(session_id: &str) -> Option<PathBuf> {
    find_claude_code_session_meta(session_id).map(|meta| meta.jsonl_path)
}

pub fn claude_code_first_event_timestamp(session_id: &str) -> Option<i64> {
    let path = find_claude_code_session_path(session_id)?;
    read_claude_code_session_detail(&path)?
        .events
        .iter()
        .map(|event| event.timestamp_ms)
        .min()
}

pub fn scan_codex_session_dir() -> Vec<JsonlSessionMeta> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    scan_codex_session_dir_at(&root)
}

pub fn scan_codex_session_dir_at(root: &Path) -> Vec<JsonlSessionMeta> {
    let files = cached_jsonl_files(root, codex_directory_listing_cache());
    files
        .iter()
        .filter_map(|file| {
            read_cached_meta_at_mtime(
                &file.path,
                file.mtime,
                codex_meta_cache(),
                read_codex_session_meta_uncached,
            )
        })
        .collect::<Vec<_>>()
        .tap_sort_newest_first()
}

pub fn read_codex_session_meta(path: &Path) -> Option<JsonlSessionMeta> {
    read_cached_meta(path, codex_meta_cache(), read_codex_session_meta_uncached)
}

pub fn read_codex_session_detail(path: &Path) -> Option<Arc<JsonlSessionDetail>> {
    read_cached_detail(
        path,
        codex_detail_cache(),
        read_codex_session_detail_uncached,
    )
}

pub fn find_codex_session_meta(session_id: &str) -> Option<JsonlSessionMeta> {
    scan_codex_session_dir()
        .into_iter()
        .find(|meta| meta.session_id == session_id)
}

pub fn find_codex_session_path(session_id: &str) -> Option<PathBuf> {
    find_codex_session_meta(session_id).map(|meta| meta.jsonl_path)
}

pub fn codex_first_event_timestamp(session_id: &str) -> Option<i64> {
    let path = find_codex_session_path(session_id)?;
    read_codex_session_detail(&path)?
        .events
        .iter()
        .map(|event| event.timestamp_ms)
        .min()
}

/// A file's mtime can lag a provider timestamp by a small amount, so leave a
/// margin before treating an incremental anchor as newer than the file.
pub(crate) fn source_file_mtime_is_not_newer_than(
    meta: &JsonlSessionMeta,
    since_timestamp: i64,
) -> bool {
    system_time_ms(meta.source_mtime).saturating_add(SOURCE_MTIME_CLOCK_SKEW_MS) <= since_timestamp
}

fn read_cached_meta(
    path: &Path,
    cache: &'static RwLock<MetaCache>,
    reader: fn(&Path, SystemTime) -> Option<JsonlSessionMeta>,
) -> Option<JsonlSessionMeta> {
    let mtime = file_mtime(path)?;
    read_cached_meta_at_mtime(path, mtime, cache, reader)
}

fn read_cached_meta_at_mtime(
    path: &Path,
    mtime: SystemTime,
    cache: &'static RwLock<MetaCache>,
    reader: fn(&Path, SystemTime) -> Option<JsonlSessionMeta>,
) -> Option<JsonlSessionMeta> {
    if let Ok(cache) = cache.read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return cached.as_deref().cloned();
            }
        }
    }

    let meta = reader(path, mtime).map(Arc::new);
    if let Ok(mut cache) = cache.write() {
        cache.insert(path.to_path_buf(), (mtime, meta.clone()));
    }
    meta.as_deref().cloned()
}

fn read_cached_detail(
    path: &Path,
    cache: &'static RwLock<DetailCache>,
    reader: fn(&Path, SystemTime) -> Option<JsonlSessionDetail>,
) -> Option<Arc<JsonlSessionDetail>> {
    let mtime = file_mtime(path)?;
    read_cached_detail_at_mtime(path, mtime, cache, reader)
}

fn read_cached_detail_at_mtime(
    path: &Path,
    mtime: SystemTime,
    cache: &'static RwLock<DetailCache>,
    reader: fn(&Path, SystemTime) -> Option<JsonlSessionDetail>,
) -> Option<Arc<JsonlSessionDetail>> {
    if let Ok(cache) = cache.read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return cached.clone();
            }
        }
    }

    let detail = reader(path, mtime).map(Arc::new);
    if let Ok(mut cache) = cache.write() {
        cache.insert(path.to_path_buf(), (mtime, detail.clone()));
    }
    detail
}

fn read_claude_code_session_meta_uncached(
    path: &Path,
    mtime: SystemTime,
) -> Option<JsonlSessionMeta> {
    read_cached_detail_at_mtime(
        path,
        mtime,
        claude_detail_cache(),
        read_claude_code_session_detail_uncached,
    )
    .map(|detail| detail.meta.clone())
}

fn read_claude_code_session_detail_uncached(
    path: &Path,
    mtime: SystemTime,
) -> Option<JsonlSessionDetail> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut events_by_message_id = HashMap::new();
    let mut session_id = String::new();
    let mut cwd = String::new();

    for (line_index, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Some(entry) = parse_json_line(&line) else {
            continue;
        };
        let Some(event) = claude_code_event_from_entry(&entry) else {
            continue;
        };
        if session_id.is_empty() {
            session_id = event.session_id.clone();
        }
        if cwd.is_empty() {
            cwd = get_optional_string(&entry, "cwd").unwrap_or_default();
        }
        // Claude Code emits one assistant entry for each content block in an API
        // message. The final block carries the message's final token usage.
        events_by_message_id.insert(event.message_id.clone(), (line_index, event));
    }

    if events_by_message_id.is_empty() {
        return None;
    }
    let mut events: Vec<_> = events_by_message_id.into_values().collect();
    events.sort_by_key(|(line_index, event)| (event.timestamp_ms, *line_index));
    let events: Vec<_> = events.into_iter().map(|(_, event)| event).collect();
    if session_id.is_empty() {
        session_id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
    }
    let created = events
        .iter()
        .map(|event| event.timestamp_ms)
        .min()
        .unwrap_or_else(|| system_time_ms(mtime));
    let modified = events
        .iter()
        .map(|event| event.timestamp_ms)
        .max()
        .unwrap_or_else(|| system_time_ms(mtime).max(created));
    let meta = JsonlSessionMeta {
        session_id,
        jsonl_path: path.to_path_buf(),
        cwd,
        created,
        modified,
        event_count: events.len() as u32,
        source_mtime: mtime,
    };
    Some(JsonlSessionDetail { meta, events })
}

fn claude_code_event_from_entry(entry: &Value) -> Option<JsonlCacheEvent> {
    if entry.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    // Claude Code sidechain entries are separate subagent conversations interleaved
    // into the same store; including them would corrupt main-session retention.
    if entry
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let message = entry.get("message")?;
    let usage = message.get("usage")?;
    let input = get_i64_any(usage, &["input_tokens"]);
    let cache_read = get_i64_any(usage, &["cache_read_input_tokens"]);
    let cache_write = get_i64_any(usage, &["cache_creation_input_tokens"]);
    let output = get_i64_any(usage, &["output_tokens"]);
    let total = input + cache_read + cache_write + output;
    if total == 0 {
        return None;
    }
    Some(JsonlCacheEvent {
        message_id: get_optional_string(message, "id")
            .or_else(|| get_optional_string(entry, "uuid"))?,
        session_id: get_optional_string(entry, "sessionId")?,
        timestamp_ms: parse_ts_ms(entry.get("timestamp"))?,
        input_tokens: input,
        cache_read,
        cache_write,
        total_tokens: total,
        model: get_optional_string(message, "model"),
        finish: get_optional_string(message, "stop_reason"),
        context_limit: None,
    })
}

fn read_codex_session_meta_uncached(path: &Path, mtime: SystemTime) -> Option<JsonlSessionMeta> {
    read_cached_detail_at_mtime(
        path,
        mtime,
        codex_detail_cache(),
        read_codex_session_detail_uncached,
    )
    .map(|detail| detail.meta.clone())
}

fn read_codex_session_detail_uncached(
    path: &Path,
    mtime: SystemTime,
) -> Option<JsonlSessionDetail> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut created = None;
    let mut events = Vec::new();

    for (line_index, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Some(entry) = parse_json_line(&line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session_meta") {
            session_id = codex_session_meta_id(&entry)
                .or_else(|| session_id_from_codex_filename(path))
                .unwrap_or_default();
            cwd = codex_session_meta_cwd(&entry).unwrap_or_default();
            created = parse_ts_ms(entry.get("timestamp"));
            continue;
        }
        let Some(event) = codex_event_from_entry(&entry, &session_id, line_index) else {
            continue;
        };
        events.push(event);
    }

    if session_id.is_empty() {
        session_id = session_id_from_codex_filename(path).unwrap_or_default();
    }
    if session_id.is_empty() || events.is_empty() {
        return None;
    }
    for event in &mut events {
        if event.session_id.is_empty() {
            event.session_id = session_id.clone();
            event.message_id = format!("{}-tc-{}", session_id, event.message_id);
        }
    }
    events.sort_by_key(|event| event.timestamp_ms);
    let first_event = events
        .iter()
        .map(|event| event.timestamp_ms)
        .min()
        .unwrap_or_else(|| system_time_ms(mtime));
    let created = created.unwrap_or(first_event);
    let modified = events
        .iter()
        .map(|event| event.timestamp_ms)
        .max()
        .unwrap_or_else(|| system_time_ms(mtime).max(created));
    let meta = JsonlSessionMeta {
        session_id,
        jsonl_path: path.to_path_buf(),
        cwd,
        created,
        modified,
        event_count: events.len() as u32,
        source_mtime: mtime,
    };
    Some(JsonlSessionDetail { meta, events })
}

fn codex_event_from_entry(
    entry: &Value,
    session_id: &str,
    line_index: usize,
) -> Option<JsonlCacheEvent> {
    if entry.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = entry.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?;
    let usage = info.get("last_token_usage")?;
    let raw_input = get_i64_any(usage, &["input_tokens"]);
    let cache_read = get_i64_any(usage, &["cached_input_tokens"]);
    // Codex reports input_tokens as total prompt input including cached tokens.
    // Normalize to the OpenCode shape where `input_tokens` means uncached input.
    let input = raw_input.saturating_sub(cache_read);
    let output = get_i64_any(usage, &["output_tokens"]);
    let total = get_i64_any(usage, &["total_tokens"]).max(input + cache_read + output);
    if total == 0 {
        return None;
    }
    let message_id = if session_id.is_empty() {
        line_index.to_string()
    } else {
        format!("{}-tc-{}", session_id, line_index)
    };
    Some(JsonlCacheEvent {
        message_id,
        session_id: session_id.to_string(),
        timestamp_ms: parse_ts_ms(entry.get("timestamp"))?,
        input_tokens: input,
        cache_read,
        cache_write: 0,
        total_tokens: total,
        model: get_optional_string(info, "model"),
        finish: None,
        context_limit: get_i64_any_optional(info, &["model_context_window"]),
    })
}

fn codex_session_meta_id(entry: &Value) -> Option<String> {
    entry
        .get("payload")
        .and_then(|payload| get_optional_string_any(payload, &["id", "session_id", "sessionId"]))
        .or_else(|| get_optional_string_any(entry, &["session_id", "sessionId", "id"]))
}

fn codex_session_meta_cwd(entry: &Value) -> Option<String> {
    entry
        .get("payload")
        .and_then(|payload| get_optional_string_any(payload, &["cwd", "worktree", "directory"]))
        .or_else(|| get_optional_string_any(entry, &["cwd", "worktree", "directory"]))
}

fn session_id_from_codex_filename(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(ToString::to_string)
}

fn cached_jsonl_files(
    root: &Path,
    cache: &'static RwLock<DirectoryListingCache>,
) -> Arc<Vec<ScannedJsonlFile>> {
    let now = Instant::now();
    if let Ok(cache) = cache.read() {
        if let Some(cached) = cache.get(root) {
            if now.duration_since(cached.scanned_at) < DIRECTORY_LISTING_TTL {
                return Arc::clone(&cached.files);
            }
        }
    }

    let files = Arc::new(scan_jsonl_files(root));
    if let Ok(mut cache) = cache.write() {
        cache.insert(
            root.to_path_buf(),
            CachedDirectoryListing {
                scanned_at: now,
                files: Arc::clone(&files),
            },
        );
    }
    files
}

fn scan_jsonl_files(root: &Path) -> Vec<ScannedJsonlFile> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    visit_jsonl_files(root, &mut visited, &mut files);
    files
}

fn visit_jsonl_files(
    root: &Path,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<ScannedJsonlFile>,
) {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !visited.insert(canonical) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            visit_jsonl_files(&path, visited, files);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            let Some(mtime) = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
            else {
                continue;
            };
            files.push(ScannedJsonlFile { path, mtime });
        }
    }
}

trait SortNewestFirst {
    fn tap_sort_newest_first(self) -> Self;
}

impl SortNewestFirst for Vec<JsonlSessionMeta> {
    fn tap_sort_newest_first(mut self) -> Self {
        self.sort_by_key(|meta| std::cmp::Reverse(meta.modified));
        self
    }
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn system_time_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_json_line(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn parse_ts_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .ok()
            .or_else(|| s.parse::<i64>().ok()),
        _ => None,
    }
}

fn get_i64_any(value: &Value, keys: &[&str]) -> i64 {
    get_i64_any_optional(value, keys).unwrap_or(0)
}

fn get_i64_any_optional(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_i64)
            .or_else(|| value.get(*key).and_then(Value::as_u64).map(|n| n as i64))
    })
}

fn get_optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn get_optional_string_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| get_optional_string(value, key))
}

#[cfg(test)]
pub fn clear_caches_for_tests() {
    for cache in [claude_meta_cache(), codex_meta_cache()] {
        if let Ok(mut cache) = cache.write() {
            cache.clear();
        }
    }
    for cache in [claude_detail_cache(), codex_detail_cache()] {
        if let Ok(mut cache) = cache.write() {
            cache.clear();
        }
    }
    for cache in [
        claude_directory_listing_cache(),
        codex_directory_listing_cache(),
    ] {
        if let Ok(mut cache) = cache.write() {
            cache.clear();
        }
    }
    if let Ok(mut root) = claude_test_root().write() {
        *root = None;
    }
    if let Ok(mut root) = codex_test_root().write() {
        *root = None;
    }
}

#[cfg(test)]
pub fn set_claude_code_test_root_for_tests(path: PathBuf) {
    if let Ok(mut root) = claude_test_root().write() {
        *root = Some(path);
    }
}

#[cfg(test)]
pub fn set_codex_test_root_for_tests(path: PathBuf) {
    if let Ok(mut root) = codex_test_root().write() {
        *root = Some(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn parses_claude_code_usage_and_skips_sidechains() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("-tmp-proj/session-1.jsonl");
        write_fixture(
            &path,
            r#"{"type":"assistant","uuid":"cc-block-1","sessionId":"cc-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"id":"msg-shared","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":25,"output_tokens":5}}}
{"type":"assistant","uuid":"cc-block-2","sessionId":"cc-session","timestamp":"2026-01-01T00:00:01.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"id":"msg-shared","model":"claude-sonnet-4-20250514","stop_reason":"end_turn","usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":25,"output_tokens":10}}}
{"type":"assistant","uuid":"cc-main-2","sessionId":"cc-session","timestamp":"2026-01-01T00:00:02.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"id":"msg-bystander","model":"claude-sonnet-4-20250514","stop_reason":"end_turn","usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":0,"output_tokens":2}}}
{"type":"assistant","uuid":"cc-side-1","sessionId":"cc-session","timestamp":"2026-01-01T00:00:03.000Z","cwd":"/tmp/proj","isSidechain":true,"message":{"id":"msg-sidechain","model":"claude-sonnet-4-20250514","usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}
{"type":"assistant","uuid":"cc-zero","sessionId":"cc-session","timestamp":"2026-01-01T00:00:04.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"id":"msg-zero","model":"claude-sonnet-4-20250514","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}
"#,
        );

        let detail = read_claude_code_session_detail(&path).unwrap();
        assert_eq!(detail.meta.session_id, "cc-session");
        assert_eq!(detail.events.len(), 2);

        let shared = &detail.events[0];
        assert_eq!(shared.message_id, "msg-shared");
        assert_eq!(shared.input_tokens, 10);
        assert_eq!(shared.cache_read, 100);
        assert_eq!(shared.cache_write, 25);
        assert_eq!(shared.total_tokens, 145);
        assert_eq!(shared.finish.as_deref(), Some("end_turn"));

        let bystander = &detail.events[1];
        assert_eq!(bystander.message_id, "msg-bystander");
        assert_eq!(bystander.total_tokens, 9);
    }

    #[test]
    fn parses_codex_token_counts_with_input_normalization() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("2026/01/01/rollout-2026-01-01T000000Z-codex-session.jsonl");
        write_fixture(
            &path,
            r#"{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"codex-session","cwd":"/tmp/proj"}}
{"timestamp":"2026-01-01T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":200000,"last_token_usage":{"input_tokens":1500,"cached_input_tokens":1200,"output_tokens":50,"total_tokens":1550}}}}
"#,
        );

        let detail = read_codex_session_detail(&path).unwrap();
        assert_eq!(detail.meta.session_id, "codex-session");
        assert_eq!(detail.events.len(), 1);
        let event = &detail.events[0];
        assert_eq!(event.message_id, "codex-session-tc-1");
        assert_eq!(event.input_tokens, 300);
        assert_eq!(event.cache_read, 1200);
        assert_eq!(event.cache_write, 0);
        assert_eq!(event.total_tokens, 1550);
        assert_eq!(event.context_limit, Some(200000));
    }

    #[test]
    fn warm_detail_reads_share_the_cached_arc() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project/session.jsonl");
        write_fixture(
            &path,
            r#"{"type":"assistant","uuid":"cc-main-1","sessionId":"cc-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":25,"output_tokens":5}}}
"#,
        );

        let first = read_claude_code_session_detail(&path).unwrap();
        let second = read_claude_code_session_detail(&path).unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.events[0].message_id, "cc-main-1");
    }
}
