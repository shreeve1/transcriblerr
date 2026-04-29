use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "com.transcriblerr.app";
const LLM_API_KEY_ACCOUNT: &str = "llm-api-key";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub has_stored_key: bool,
    pub has_env_key: bool,
    pub has_any_key: bool,
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn shared_env_api_key() -> Option<String> {
    env_string("LLM_API_KEY")
}

fn summary_env_api_key() -> Option<String> {
    env_string("LLM_SUMMARY_API_KEY")
}

fn read_stored_llm_api_key() -> Result<Option<String>, String> {
    match get_generic_password(KEYCHAIN_SERVICE, LLM_API_KEY_ACCOUNT) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
            .map_err(|_| "Stored API key is not valid UTF-8".to_string()),
        Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(err) => Err(format!("Failed to read API key from Keychain: {}", err)),
    }
}

pub fn normalize_api_key(raw_key: &str) -> Result<String, String> {
    let trimmed = raw_key.trim();
    if trimmed.is_empty() {
        Err("API key cannot be empty".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

pub fn has_stored_llm_api_key() -> Result<bool, String> {
    read_stored_llm_api_key().map(|key| key.is_some())
}

pub fn get_llm_api_key() -> Result<Option<String>, String> {
    match read_stored_llm_api_key()? {
        Some(key) => Ok(Some(key)),
        None => Ok(shared_env_api_key()),
    }
}

pub fn get_summary_api_key() -> Result<Option<String>, String> {
    match read_stored_llm_api_key()? {
        Some(key) => Ok(Some(key)),
        None => Ok(shared_env_api_key().or_else(summary_env_api_key)),
    }
}

pub fn set_stored_llm_api_key(raw_key: &str) -> Result<(), String> {
    let key = normalize_api_key(raw_key)?;
    set_generic_password(KEYCHAIN_SERVICE, LLM_API_KEY_ACCOUNT, key.as_bytes())
        .map_err(|err| format!("Failed to save API key to Keychain: {}", err))
}

pub fn delete_stored_llm_api_key() -> Result<(), String> {
    match delete_generic_password(KEYCHAIN_SERVICE, LLM_API_KEY_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(err) => Err(format!("Failed to delete API key from Keychain: {}", err)),
    }
}

pub fn api_key_status() -> Result<ApiKeyStatus, String> {
    let has_stored_key = has_stored_llm_api_key()?;
    let has_env_key = shared_env_api_key().is_some() || summary_env_api_key().is_some();
    Ok(ApiKeyStatus {
        has_stored_key,
        has_env_key,
        has_any_key: has_stored_key || has_env_key,
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_api_key;

    #[test]
    fn normalize_api_key_trims_valid_keys() {
        assert_eq!(normalize_api_key("  sk-test  ").unwrap(), "sk-test");
    }

    #[test]
    fn normalize_api_key_rejects_empty_keys() {
        assert!(normalize_api_key("   ").is_err());
    }
}
