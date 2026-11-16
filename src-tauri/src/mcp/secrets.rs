//! At-rest secret storage for custom MCP servers.
//!
//! Secrets never live in `custom_mcp_servers.transport_config_json`; they are
//! sealed with AES-256-GCM under a per-install key. On Windows the key itself
//! is wrapped with DPAPI, so copying `secrets.key` to another user or machine
//! does not reveal it. Elsewhere the key file is written with mode `0600`.
//!
//! `Secrets` only handles the cipher and the key file; the ciphertext rows live
//! in the `app_secrets` table (see `store::secrets`).

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::PultError;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const BLOB_VERSION: u8 = 1;
const KEY_FILE: &str = "secrets.key";

pub struct Secrets {
    cipher: Aes256Gcm,
}

impl Secrets {
    /// Loads the install key from `dir`, creating it on first use. A `None`
    /// directory (in-memory store / tests) keeps the key in memory only.
    pub fn load(dir: Option<&Path>) -> Result<Self, PultError> {
        let key = match dir {
            Some(dir) => load_or_create_key(&dir.join(KEY_FILE))?,
            None => random_bytes(KEY_LEN)?,
        };
        Self::from_key(&key)
    }

    /// Ephemeral vault: secrets survive while this store lives, nothing on disk.
    pub fn ephemeral() -> Result<Self, PultError> {
        Self::from_key(&random_bytes(KEY_LEN)?)
    }

    fn from_key(key: &[u8]) -> Result<Self, PultError> {
        if key.len() != KEY_LEN {
            return Err(secret_error("install key has an unexpected length"));
        }
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| secret_error("install key rejected by AES-GCM"))?;
        Ok(Self { cipher })
    }

    pub fn seal(&self, plaintext: &str) -> Result<Vec<u8>, PultError> {
        let nonce_bytes = random_bytes(NONCE_LEN)?;
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| secret_error("encrypt secret"))?;
        let mut blob = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        blob.push(BLOB_VERSION);
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    pub fn open(&self, blob: &[u8]) -> Result<String, PultError> {
        if blob.len() < 1 + NONCE_LEN + TAG_LEN || blob[0] != BLOB_VERSION {
            return Err(secret_error(
                "stored secret is corrupt or from another version",
            ));
        }
        let nonce = Nonce::from_slice(&blob[1..1 + NONCE_LEN]);
        let plaintext = self
            .cipher
            .decrypt(nonce, &blob[1 + NONCE_LEN..])
            .map_err(|_| secret_error("stored secret could not be decrypted"))?;
        String::from_utf8(plaintext).map_err(|_| secret_error("stored secret is not UTF-8"))
    }
}

/// Mask shown to the UI: never the whole value, never short values in full.
pub fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 4 {
        return "••••".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("••••{tail}")
}

fn random_bytes(len: usize) -> Result<Vec<u8>, PultError> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|e| secret_error(format!("random bytes: {e}")))?;
    Ok(bytes)
}

fn load_or_create_key(path: &PathBuf) -> Result<Vec<u8>, PultError> {
    if path.exists() {
        let stored = std::fs::read(path)
            .map_err(|e| secret_error(format!("read {}: {e}", path.display())))?;
        let key = unwrap_key(&stored)?;
        if key.len() != KEY_LEN {
            return Err(secret_error("install key has an unexpected length"));
        }
        return Ok(key);
    }
    let key = random_bytes(KEY_LEN)?;
    let stored = wrap_key(&key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| secret_error(format!("create {}: {e}", parent.display())))?;
    }
    write_key_file(path, &stored)?;
    Ok(key)
}

#[cfg(windows)]
fn wrap_key(key: &[u8]) -> Result<Vec<u8>, PultError> {
    dpapi_protect(key)
}

#[cfg(windows)]
fn unwrap_key(stored: &[u8]) -> Result<Vec<u8>, PultError> {
    dpapi_unprotect(stored)
}

#[cfg(not(windows))]
fn wrap_key(key: &[u8]) -> Result<Vec<u8>, PultError> {
    Ok(key.to_vec())
}

#[cfg(not(windows))]
fn unwrap_key(stored: &[u8]) -> Result<Vec<u8>, PultError> {
    Ok(stored.to_vec())
}

#[cfg(windows)]
fn write_key_file(path: &Path, bytes: &[u8]) -> Result<(), PultError> {
    std::fs::write(path, bytes).map_err(|e| secret_error(format!("write {}: {e}", path.display())))
}

#[cfg(not(windows))]
fn write_key_file(path: &Path, bytes: &[u8]) -> Result<(), PultError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| secret_error(format!("create {}: {e}", path.display())))?;
    file.write_all(bytes)
        .map_err(|e| secret_error(format!("write {}: {e}", path.display())))
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, PultError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: both blobs point at live buffers for the duration of the call;
    // DPAPI allocates `output.pbData`, released with LocalFree below.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(secret_error(format!(
            "DPAPI protect failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn dpapi_unprotect(stored: &[u8]) -> Result<Vec<u8>, PultError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: stored.len() as u32,
        pbData: stored.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: same contract as `dpapi_protect`; `output` is allocator-owned.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(secret_error(format!(
            "DPAPI unprotect failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(bytes)
}

fn secret_error(message: impl std::fmt::Display) -> PultError {
    PultError::with_code("mcp.secret_store", message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_values_and_rejects_tampering() {
        let secrets = Secrets::ephemeral().unwrap();
        let blob = secrets.seal("super-secret-value").unwrap();
        assert!(!blob
            .windows(b"super-secret".len())
            .any(|w| w == b"super-secret"));
        assert_eq!(secrets.open(&blob).unwrap(), "super-secret-value");

        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(secrets.open(&tampered).is_err());
        assert!(secrets.open(&[9, 9, 9]).is_err());
    }

    #[test]
    fn masks_values_without_exposing_short_ones() {
        assert_eq!(mask_secret("abcd"), "••••");
        assert_eq!(mask_secret("abc"), "••••");
        assert_eq!(mask_secret("abcdefgh"), "••••efgh");
    }

    #[test]
    fn install_key_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!(
            "pult-secrets-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let blob = Secrets::load(Some(&dir)).unwrap().seal("value-1").unwrap();
        let reloaded = Secrets::load(Some(&dir)).unwrap();
        assert_eq!(reloaded.open(&blob).unwrap(), "value-1");
        let stored = std::fs::read(dir.join(KEY_FILE)).unwrap();
        #[cfg(windows)]
        assert!(stored.len() > KEY_LEN, "DPAPI must wrap the key");
        #[cfg(not(windows))]
        assert_eq!(stored.len(), KEY_LEN);
        std::fs::remove_dir_all(&dir).ok();
    }
}
