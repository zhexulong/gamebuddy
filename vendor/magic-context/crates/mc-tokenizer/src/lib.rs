//! Claude BPE token estimator — a bit-faithful Rust port of `ai-tokenizer`'s
//! `claude` encoding, which the TS `estimateTokens` uses.
//!
//! `estimateTokens(text)` in the TS harness is `Tokenizer(claudeEncoding).encode(
//! text, "all").length`. The `"all"` mode byte-BPEs special-token substrings as
//! LITERAL text (e.g. `<EOT>` → 4 byte tokens, not the special rank), i.e. it is a
//! plain byte-BPE with NO special-token handling — exactly tiktoken's
//! `encode_ordinary` / `count_ordinary`. So this crate builds a `CoreBPE` from the
//! vendored claude vocab (`assets/claude.tiktoken`, generated from
//! `ai-tokenizer/encoding/claude` by `gen/gen-claude-vocab.ts`) plus the claude
//! `pat_str`, and exposes [`estimate_tokens`].
//!
//! DETERMINISM is the load-bearing property (the module's cache-stability core
//! only ever calls this on a HARD m0 rematerialization, and a resume must produce
//! byte-identical m0). The vocab is VENDORED and frozen, and tiktoken-rs +
//! fancy-regex are version-pinned, so the same text tokenizes identically across
//! runs and machines. Bit-exact agreement with the TS `ai-tokenizer` is a
//! FAITHFULNESS goal (validated by the differential golden in `tests/`), not a
//! runtime invariant — only this implementation runs in the target.
//!
//! Relocation-clean: the public surface is a plain `estimate_tokens(&str) ->
//! usize` with no Magic-Context coupling, so this crate can move to a shared
//! `commons` home (with a vocab registry) if a second consumer — e.g. the
//! llm-runner — ever needs a Claude tokenizer.

use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rustc_hash::FxHashMap;
use tiktoken_rs::{CoreBPE, Rank};

/// The vendored Claude BPE vocab: `base64(token_bytes) SP rank` per line, unified
/// from `ai-tokenizer/encoding/claude`'s string + binary encoders. Embedded at
/// build time so there is no runtime file read or network fetch (both would break
/// the determinism guarantee on resume).
const CLAUDE_TIKTOKEN: &str = include_str!("../assets/claude.tiktoken");

/// The Claude pre-tokenization split pattern (`pat_str` from
/// `ai-tokenizer/encoding/claude`). The standard GPT-2 pattern: contractions,
/// letter runs, number runs, punctuation runs, and whitespace (with a `(?!\S)`
/// lookahead that fancy-regex supports).
const CLAUDE_PAT_STR: &str =
    r"'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+";

fn tokenizer() -> &'static CoreBPE {
    static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();
    TOKENIZER.get_or_init(|| {
        let mut encoder: FxHashMap<Vec<u8>, Rank> = FxHashMap::default();
        for line in CLAUDE_TIKTOKEN.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split(' ');
            let raw = parts.next().expect("vocab line missing token field");
            let rank_str = parts.next().expect("vocab line missing rank field");
            let bytes = STANDARD
                .decode(raw)
                .expect("vocab token is not valid base64");
            let rank: Rank = rank_str.parse().expect("vocab rank is not a u32");
            encoder.insert(bytes, rank);
        }
        // No special-token encoder: estimate_tokens is byte-BPE only (matches the
        // TS `encode(_, "all")` semantics), so specials are never consulted.
        CoreBPE::new(encoder, FxHashMap::default(), CLAUDE_PAT_STR)
            .expect("claude BPE construction failed (bad vocab or pattern)")
    })
}

/// Count the Claude BPE tokens in `text` — the Rust equivalent of the TS
/// `estimateTokens`. Empty text is 0 (matching the TS falsy-guard); otherwise it
/// is the length of the ordinary (special-free) byte-BPE encoding.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    tokenizer().count_ordinary(text)
}

/// The full token-ID sequence for `text` (ordinary byte-BPE). Exposed for the
/// differential golden, which asserts the exact IDs match `ai-tokenizer` — a
/// stronger check than the count alone (it catches count-coincident merge bugs).
pub fn encode_ordinary(text: &str) -> Vec<Rank> {
    tokenizer().encode_ordinary(text)
}
