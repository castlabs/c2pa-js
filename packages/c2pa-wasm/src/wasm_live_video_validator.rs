// Copyright 2026 Adobe
// All Rights Reserved.
//
// NOTICE: Adobe permits you to use, modify, and distribute this file in
// accordance with the terms of the Adobe license agreement accompanying
// it.

//! Owned section 19.4 validator. No raw-key admission or section 19.3 fallback.

use std::{
    io::{Cursor, Read},
    sync::Arc,
};

use c2pa::{
    Context, Reader, ValidationState,
    assertions::SessionKeys,
    live_video::LiveVideoValidator,
    status_tracker::{LogKind, StatusTracker},
};
use js_sys::JsString;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use web_sys::Blob;

use crate::stream::BlobStream;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Coverage {
    missing_ranges: Vec<[String; 2]>,
    total_missing: String,
    ranges_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    kind: &'static str,
    code: String,
    label: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ingredient_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_list_uri: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    valid: bool,
    statuses: Vec<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    sequence_coverage: Coverage,
    had_failures: bool,
}

struct VerifiedInit {
    label: String,
    keys: SessionKeys,
    leaf: Vec<u8>,
}

fn error(e: impl std::fmt::Display) -> JsString {
    JsString::from(e.to_string())
}

fn failed(tracker: &StatusTracker) -> bool {
    tracker.has_any_error()
        || tracker
            .logged_items()
            .iter()
            .any(|s| s.kind == LogKind::Failure)
}

fn blob_bytes(blob: &Blob) -> Result<Vec<u8>, JsString> {
    let mut bytes = Vec::new();
    BlobStream::new(blob)
        .map_err(error)?
        .read_to_end(&mut bytes)
        .map_err(error)?;
    Ok(bytes)
}

async fn verify_init(
    context: &Arc<Context>,
    format: &str,
    bytes: &[u8],
) -> Result<VerifiedInit, String> {
    let reader = Reader::from_shared_context(context)
        .with_stream_async(format, Cursor::new(bytes.to_vec()))
        .await
        .map_err(|e| e.to_string())?;
    let active = reader
        .validation_results()
        .and_then(|r| r.active_manifest())
        .ok_or("init has no detailed active-manifest verification results")?;
    if reader.validation_state() != ValidationState::Trusted
        || !active.failure().is_empty()
        || !active
            .success()
            .iter()
            .any(|s| s.code() == "signingCredential.trusted")
        || !active
            .success()
            .iter()
            .any(|s| s.code() == "assertion.bmffHash.match")
    {
        return Err(
            "init must have a trusted signer, valid assertions and verified BMFF hard binding"
                .into(),
        );
    }
    let manifest = reader
        .active_manifest()
        .ok_or("init has no active manifest")?;
    for (prefix, exact) in [
        (SessionKeys::LABEL, SessionKeys::LABEL),
        ("c2pa.hash.bmff", "c2pa.hash.bmff.v3"),
    ] {
        let matches: Vec<_> = manifest
            .assertions()
            .iter()
            .filter(|a| a.label().starts_with(prefix))
            .collect();
        if matches.len() != 1 || matches[0].label() != exact {
            return Err(format!(
                "init requires exactly one unambiguous {exact} assertion"
            ));
        }
    }
    let keys = manifest
        .find_assertion::<SessionKeys>(SessionKeys::LABEL)
        .map_err(|e| e.to_string())?;
    let chain = manifest
        .signature_info()
        .ok_or("init has no signature info")?
        .cert_chain();
    // Reader's verified COSE signature uses certs[0] as its signing certificate.
    let leaf = pem::parse_many(chain)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.tag() == "CERTIFICATE")
        .ok_or("init has no signing certificate")?
        .into_contents();
    Ok(VerifiedInit {
        label: reader
            .active_label()
            .ok_or("init has no active label")?
            .to_owned(),
        keys,
        leaf,
    })
}

/// One logical stream/rendition observation with snapshotted verification policy.
/// Callers must not mix unrelated streams, codecs or sample entries on refresh.
/// Direct WASM consumers must serialize calls, including free, across async refresh.
#[wasm_bindgen]
pub struct WasmLiveVideoValidator {
    validator: LiveVideoValidator,
    context: Arc<Context>,
    had_failures: bool,
}

#[wasm_bindgen]
impl WasmLiveVideoValidator {
    /// Verifies the complete signed init before admitting an owned validator.
    #[wasm_bindgen(js_name = fromInitBytes)]
    pub async fn from_init_bytes(
        format: &str,
        bytes: Vec<u8>,
        context_json: Option<String>,
    ) -> Result<WasmLiveVideoValidator, JsString> {
        let context = match context_json {
            Some(json) => Context::new().with_settings(json.as_str()).map_err(error)?,
            None => Context::new(),
        };
        for setting in [
            "verify.verify_after_reading",
            "verify.verify_trust",
            "verify.verify_timestamp_trust",
        ] {
            if !context
                .settings()
                .get_value::<bool>(setting)
                .map_err(error)?
            {
                return Err(error(format!("live validation requires {setting}=true")));
            }
        }
        if context
            .settings()
            .get_value::<bool>("verify.strict_v1_validation")
            .map_err(error)?
        {
            return Err(error(
                "live validation requires detailed validation results (strict_v1_validation=false)",
            ));
        }
        let context = Arc::new(context);
        let init = verify_init(&context, format, &bytes).await.map_err(error)?;
        let mut validator = LiveVideoValidator::new();
        let mut tracker = StatusTracker::default();
        validator
            .validate_init_segment(&bytes, &mut tracker)
            .map_err(error)?;
        validator
            .validate_session_keys(&init.keys, &init.label, Some(&init.leaf), &mut tracker)
            .map_err(error)?;
        if failed(&tracker) {
            return Err(error(format!(
                "live init admission failed: {:?}",
                tracker.logged_items()
            )));
        }
        Ok(Self {
            validator,
            context,
            had_failures: false,
        })
    }

    /// Worker-only Blob adapter; reads all bytes before admission.
    #[wasm_bindgen(js_name = fromInitBlob)]
    pub async fn from_init_blob(
        format: &str,
        blob: &Blob,
        context_json: Option<String>,
    ) -> Result<WasmLiveVideoValidator, JsString> {
        Self::from_init_bytes(format, blob_bytes(blob)?, context_json).await
    }

    /// Validates VSI media without resetting accepted continuity on failure.
    #[wasm_bindgen(js_name = validateSegmentBytes)]
    pub fn validate_segment_bytes(&mut self, bytes: Vec<u8>) -> Result<JsValue, JsString> {
        let mut tracker = StatusTracker::default();
        let result = self
            .validator
            .validate_verifiable_segment_info(&bytes, &mut tracker);
        self.outcome(tracker, result.err().map(|e| e.to_string()))
    }

    /// Worker-only complete-Blob adapter for media validation.
    #[wasm_bindgen(js_name = validateSegmentBlob)]
    pub fn validate_segment_blob(&mut self, blob: &Blob) -> Result<JsValue, JsString> {
        match blob_bytes(blob) {
            Ok(bytes) => self.validate_segment_bytes(bytes),
            Err(e) => self.outcome(StatusTracker::default(), Some(String::from(e))),
        }
    }

    /// Reverifies trust and atomically updates keys without losing continuity.
    #[wasm_bindgen(js_name = updateInitBytes)]
    pub async fn update_init_bytes(
        &mut self,
        format: &str,
        bytes: Vec<u8>,
    ) -> Result<JsValue, JsString> {
        let mut tracker = StatusTracker::default();
        let failure = match verify_init(&self.context, format, &bytes).await {
            Ok(init) => self
                .validator
                .update_vsi_context(
                    Some(&bytes),
                    &init.keys,
                    &init.label,
                    Some(&init.leaf),
                    &mut tracker,
                )
                .err()
                .map(|e| e.to_string()),
            Err(e) => Some(e),
        };
        self.outcome(tracker, failure)
    }

    /// Worker-only complete-Blob adapter for trusted init refresh.
    #[wasm_bindgen(js_name = updateInitBlob)]
    pub async fn update_init_blob(
        &mut self,
        format: &str,
        blob: &Blob,
    ) -> Result<JsValue, JsString> {
        match blob_bytes(blob) {
            Ok(bytes) => self.update_init_bytes(format, bytes).await,
            Err(e) => self.outcome(StatusTracker::default(), Some(String::from(e))),
        }
    }

    /// Explicit trusted playback reset, retaining coverage and failure history.
    #[wasm_bindgen(js_name = resetContinuity)]
    pub fn reset_continuity(&mut self) -> Result<JsValue, JsString> {
        self.validator.reset_continuity();
        self.outcome(StatusTracker::default(), None)
    }

    /// Report-only coverage with lossless decimal-string sequence numbers.
    #[wasm_bindgen(js_name = sequenceCoverage)]
    pub fn sequence_coverage(&self) -> Result<JsValue, JsString> {
        self.coverage()
            .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
            .map_err(error)
    }
}

impl WasmLiveVideoValidator {
    fn coverage(&self) -> Coverage {
        let coverage = self.validator.sequence_coverage();
        Coverage {
            missing_ranges: coverage
                .missing_ranges
                .iter()
                .map(|r| [r.start().to_string(), r.end().to_string()])
                .collect(),
            total_missing: coverage.total_missing.to_string(),
            ranges_truncated: coverage.ranges_truncated,
        }
    }

    fn outcome(
        &mut self,
        tracker: StatusTracker,
        error: Option<String>,
    ) -> Result<JsValue, JsString> {
        let valid = error.is_none() && !failed(&tracker);
        self.had_failures |= !valid;
        let statuses = tracker
            .logged_items()
            .iter()
            .map(|s| Status {
                kind: match s.kind {
                    LogKind::Success => "success",
                    LogKind::Informational => "informational",
                    LogKind::Failure => "failure",
                },
                code: s.validation_status.as_deref().unwrap_or("").to_owned(),
                label: s.label.to_string(),
                description: s.description.to_string(),
                error: s.err_val.as_deref().map(str::to_owned),
                ingredient_uri: s.ingredient_uri.as_deref().map(str::to_owned),
                trust_list_uri: s.trust_list_uri.as_deref().map(str::to_owned),
            })
            .collect();
        Outcome {
            valid,
            statuses,
            error,
            sequence_coverage: self.coverage(),
            had_failures: self.had_failures,
        }
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(crate::wasm_live_video_validator::error)
    }
}
