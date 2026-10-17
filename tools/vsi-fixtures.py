"""CI-only signed fixtures, using the published dev2 wheel, never a native build.

Recipe adapted from c2pa-python 466707025658fd2fd5343d74b06f7081db09e64c
tests/test_trusted_vsi_api.py. These are test credentials, not production trust.
"""
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import sys

import c2pa
import cbor2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

source = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
fixtures = source / "tests/fixtures"
settings = json.loads((source / "tests/trust_config_test_settings.json").read_text())
settings["builder"] = {"thumbnail": {"enabled": False}}
settings["verify"] = {"verify_after_reading": True, "verify_trust": True, "verify_timestamp_trust": True}
assert c2pa.__version__ == "0.37.13.dev2"
assert c2pa.sdk_version() == "0.92.0-dev"
IAT = 1789041600  # 2026-09-10, within session and test claim-certificate validity.


def boxes(data):
    pos = 0
    while pos < len(data):
        size = int.from_bytes(data[pos:pos + 4], "big")
        if size == 1:
            size = int.from_bytes(data[pos + 8:pos + 16], "big")
        if size == 0:
            size = len(data) - pos
        assert size >= 8 and pos + size <= len(data)
        yield pos, data[pos + 4:pos + 8], data[pos:pos + size]
        pos += size


def child(data, *path):
    for name in path:
        data = next(box[8:] for _, kind, box in boxes(data) if kind == name)
    return data


raw_init = b"".join(box for _, kind, box in boxes((fixtures / "dashinit.mp4").read_bytes()) if kind in (b"ftyp", b"moov"))
raw_media = b"".join(box for _, kind, box in boxes((fixtures / "dash1.m4s").read_bytes()) if kind not in (b"uuid", b"emsg"))
mdhd = child(raw_init, b"moov", b"trak", b"mdia", b"mdhd")
timescale = int.from_bytes(mdhd[12:16] if mdhd[0] == 0 else mdhd[20:24], "big")
trex = child(raw_init, b"moov", b"mvex", b"trex")
default_duration = int.from_bytes(trex[12:16], "big")
traf = child(raw_media, b"moof", b"traf")
tfhd = child(traf, b"tfhd")
flags = int.from_bytes(tfhd[1:4], "big")
pos = 8 + (8 if flags & 1 else 0) + (4 if flags & 2 else 0)
if flags & 8:
    default_duration = int.from_bytes(tfhd[pos:pos + 4], "big")
duration = 0
for _, kind, box in boxes(traf):
    if kind != b"trun":
        continue
    payload = box[8:]
    flags = int.from_bytes(payload[1:4], "big")
    count = int.from_bytes(payload[4:8], "big")
    pos = 8 + (4 if flags & 1 else 0) + (4 if flags & 4 else 0)
    for _ in range(count):
        duration += int.from_bytes(payload[pos:pos + 4], "big") if flags & 0x100 else default_duration
        pos += 4 * sum(bool(flags & flag) for flag in (0x100, 0x200, 0x400, 0x800))
assert duration > 0 and timescale > 0


def place(data, box):
    first = next(boxes(data))
    split = len(first[2]) if first[1] in (b"ftyp", b"styp") else 0
    return data[:split] + box + data[split:]


def canonical(kind, data):
    template = cbor2.loads(c2pa.trusted_vsi_hash_template(kind))
    digest = hashlib.sha256()
    excluded = b"uuid" if kind == c2pa.TrustedVsiInputKind.INIT_HASH else b"emsg"
    for offset, typ, box in boxes(data):
        if typ != excluded:
            digest.update(offset.to_bytes(8, "big"))
            digest.update(box)
    template["hash"] = digest.digest()
    return cbor2.dumps(template, canonical=True)


def claim_signer():
    return c2pa.Signer.from_info(c2pa.C2paSignerInfo(
        alg=b"es256", sign_cert=(fixtures / "es256_certs.pem").read_bytes(),
        private_key=(fixtures / "es256_private.key").read_bytes(), ta_url=None))


manifest = {"claim_version": 2, "format": "video/mp4", "claim_generator_info": [{"name": "VSI browser CI fixtures", "specVersion": "2.4"}],
            "assertions": [{"label": "c2pa.actions", "data": {"actions": [{"action": "c2pa.created", "digitalSourceType": "http://c2pa.org/digitalsourcetype/empty"}]}}]}
chain = x509.load_pem_x509_certificates((fixtures / "es256_certs.pem").read_bytes())
assert len(chain) > 1
leaf = chain[0].public_bytes(serialization.Encoding.DER)
issuer = chain[-1].public_bytes(serialization.Encoding.DER)
assert issuer != leaf
bad_keys = {}
for algorithm in ("ed25519", "es256"):
    kid = b"browser-ci-session"
    if algorithm == "ed25519":
        key = ed25519.Ed25519PrivateKey.from_private_bytes(bytes([7]) * 32)
        public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        cose = {1: 1, 2: kid, 3: -8, -1: 6, -2: public}
        sign = key.sign
    else:
        key = ec.derive_private_key(7, ec.SECP256R1())
        public = key.public_key().public_numbers()
        cose = {1: 2, 2: kid, 3: -7, -1: 1, -2: public.x.to_bytes(32, "big"), -3: public.y.to_bytes(32, "big")}
        def sign(data):
            r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
            return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    # Independent keys for malformed admission fixtures. A session signs the
    # CBOR byte string containing the claim leaf, NOT the other direction.
    protected = cbor2.dumps({1: -8 if algorithm == "ed25519" else -7})
    payload = cbor2.dumps(leaf)
    binding = cbor2.CBORTag(18, [protected, {}, None, sign(cbor2.dumps(["Signature1", protected, b"", payload]))])
    good = {"key": cose, "minSequenceNumber": 1, "createdAt": cbor2.CBORTag(0, "2026-09-10T00:00:00Z"), "validityPeriod": 86400, "signerBinding": binding}
    wrong = dict(good)
    # A real issuer certificate is deliberately NOT the claim signing leaf.
    wrong_payload = cbor2.dumps(issuer)
    wrong["signerBinding"] = cbor2.CBORTag(18, [protected, {}, None, sign(cbor2.dumps(["Signature1", protected, b"", wrong_payload]))])
    mixed = {**wrong, "key": {**wrong["key"], 2: b"different-kid"}}
    bad_keys[algorithm] = {"wrong-leaf": [wrong], "mixed-keys": [good, mixed], "empty-keys": [], "missing-keys": [], "malformed-keys": [{}], "prefix-keys": [good], "duplicate-keys": [good]}

    for epoch in ("original", "refresh"):
        with claim_signer() as signer:
            with c2pa.Context.from_dict(settings, signer=signer) as context:
                with c2pa.TrustedVsiSession.from_callback(
                    context, manifest, algorithm, cbor2.dumps(cose, canonical=True), kid, 1,
                    "2026-09-10T00:00:00Z", 86400, lambda _context, data: sign(data),
                    mode="expert_sig_structure", reservation_nonce=("01" if epoch == "original" else "02") * 16,
                    signing_time_unix_seconds=IAT) as session:
                    reservation = session.reserve_init_uuid()
                    init = place(raw_init, session.finalize_init_uuid(canonical(c2pa.TrustedVsiInputKind.INIT_HASH, place(raw_init, reservation))))
                    session.commit_init_uuid()
                    with c2pa.Reader("video/mp4", io.BytesIO(init), context=context) as reader:
                        assert reader.get_validation_state() == "Trusted"
                        assert reader.get_validation_results()["activeManifest"]["failure"] == []
                    (out / f"{algorithm}-{epoch}-init.mp4").write_bytes(init)
                    for sequence in (1, 2, 4):
                        media = bytearray(raw_media)
                        mfhd = media.index(b"mfhd")
                        media[mfhd + 8:mfhd + 12] = sequence.to_bytes(4, "big")
                        media = bytes(media)
                        protected_media = cbor2.dumps({1: -8 if algorithm == "ed25519" else -7, "iat": IAT}, canonical=True)
                        event_id = sequence + (100 if epoch == "refresh" else 0)
                        def emsg(payload, signature):
                            cose_bytes = cbor2.dumps(cbor2.CBORTag(18, [protected_media, {4: kid}, payload, signature]))
                            body = bytes(4) + b"urn:c2pa:verifiable-segment-info\0fseg\0" + timescale.to_bytes(4, "big") + bytes(4) + duration.to_bytes(4, "big") + event_id.to_bytes(4, "big") + cose_bytes
                            return (len(body) + 8).to_bytes(4, "big") + b"emsg" + body
                        info = {"sequenceNumber": sequence, "manifestId": session.reserved_manifest_id(), "bmffHash": cbor2.loads(c2pa.trusted_vsi_hash_template(c2pa.TrustedVsiInputKind.MEDIA_HASH))}
                        placeholder = emsg(cbor2.dumps(info), bytes(64))
                        info["bmffHash"] = cbor2.loads(canonical(c2pa.TrustedVsiInputKind.MEDIA_HASH, place(media, placeholder)))
                        payload = cbor2.dumps(info)
                        signature = session.sign_sig_structure(cbor2.dumps(["Signature1", protected_media, b"", payload]), sequence)
                        final = emsg(payload, signature)
                        assert len(final) == len(placeholder)
                        (out / f"{algorithm}-{epoch}-{sequence}.m4s").write_bytes(place(media, final))
                        if epoch == "original" and sequence == 4:
                            # EMSG framing is excluded from the media hash. These
                            # retain a real valid COSE signature and hard binding.
                            framing = 12 + len(b"urn:c2pa:verifiable-segment-info\0fseg\0")
                            replay = bytearray(final)
                            replay[framing + 12:framing + 16] = (1).to_bytes(4, "big")
                            (out / f"{algorithm}-replay-id.m4s").write_bytes(place(media, replay))
                            wrong_time = bytearray(final)
                            wrong_time[framing + 8:framing + 12] = (duration + 1).to_bytes(4, "big")
                            (out / f"{algorithm}-wrong-time.m4s").write_bytes(place(media, wrong_time))
                            wrong_track = bytearray(media)
                            track_offset = wrong_track.index(b"tfhd") + 8
                            track_id = int.from_bytes(wrong_track[track_offset:track_offset + 4], "big")
                            wrong_track[track_offset:track_offset + 4] = (track_id + 1).to_bytes(4, "big")
                            info["bmffHash"] = cbor2.loads(canonical(c2pa.TrustedVsiInputKind.MEDIA_HASH, place(wrong_track, placeholder)))
                            payload = cbor2.dumps(info)
                            signature = session.sign_sig_structure(cbor2.dumps(["Signature1", protected_media, b"", payload]), sequence)
                            (out / f"{algorithm}-wrong-track.m4s").write_bytes(place(wrong_track, emsg(payload, signature)))

    for name, keys in bad_keys[algorithm].items():
        print(f"Generating trusted {algorithm} {name} init", flush=True)
        data = cbor2.dumps({"keys": keys})
        with claim_signer() as signer:
            if name not in ("missing-keys", "duplicate-keys"):
                label = "c2pa.session-keys.extra" if name == "prefix-keys" else "c2pa.session-keys"
                signer.add_dynamic_assertion(lambda *_: data, label=label, reserve_size=len(data))
            with c2pa.Context.from_dict(settings, signer=signer) as context:
                def json_bytes(value):
                    if isinstance(value, bytes):
                        return list(value)
                    if isinstance(value, dict):
                        return {k: json_bytes(v) for k, v in value.items()}
                    if isinstance(value, list):
                        return [json_bytes(v) for v in value]
                    return value
                init_hash = json_bytes(cbor2.loads(c2pa.trusted_vsi_hash_template(c2pa.TrustedVsiInputKind.INIT_HASH)))
                # Generic Builder preserves an explicitly supplied BMFF hash.
                # First determine final UUID placement/size, then sign the actual
                # init hash. The provisional bytes are never used for admission.
                for _ in range(2):
                    definition = {**manifest, "assertions": manifest["assertions"] + [{"label": "c2pa.hash.bmff.v3", "data": init_hash}]}
                    if name == "duplicate-keys":
                        definition["assertions"] += [{"label": "c2pa.session-keys", "data": {"keys": []}} for _ in range(2)]
                    with c2pa.Builder(definition, context=context) as builder:
                        output = io.BytesIO()
                        builder.sign("video/mp4", io.BytesIO(raw_init), output)
                        init = output.getvalue()
                    init_hash = json_bytes(cbor2.loads(canonical(c2pa.TrustedVsiInputKind.INIT_HASH, init)))
                with c2pa.Reader("video/mp4", io.BytesIO(init), context=context) as reader:
                    assert reader.get_validation_state() == "Trusted", (name, reader.get_validation_results())
                (out / f"{algorithm}-{name}-init.mp4").write_bytes(init)

(out / "context.json").write_text(json.dumps(settings))
files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.is_file()}
(out / "provenance.json").write_text(json.dumps({"python": "466707025658fd2fd5343d74b06f7081db09e64c", "sdk": "afd6fffe5a066e0b5b1a14f3f8c7ac189e7f0c95", "wheelSha256": "5b9a4bd5f56b0fdcd4dc27f42569524677505e0744b51566da7908c836ac0bfb", "generatorDependencies": {name: importlib.metadata.version(name) for name in ("cbor2", "cryptography")}, "files": files}, indent=2))
print(f"Generated {len(files)} real-crypto browser fixture files; timescale={timescale}, duration={duration}")
