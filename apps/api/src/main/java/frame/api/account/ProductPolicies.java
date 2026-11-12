package frame.api.account;

import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/** Versioned service notices and the exact versions accepted by signup share one source. */
public final class ProductPolicies {
    public static final String TERMS_VERSION = "2026-11-11";
    public static final String PRIVACY_VERSION = "2026-11-11";
    public record Section(String heading, List<String> paragraphs) {}
    public record Policy(String version, String title, boolean required, List<Section> sections) {}
    private ProductPolicies() {}

    public static Map<String, Policy> documents() {
        return Map.of(
                "terms", new Policy(TERMS_VERSION, "서비스 이용약관", true, List.of(
                        new Section("계정과 채널", List.of(
                                "FRAME은 계정, 개인 채널, 채널 팔로우와 방송 시청 기능을 제공합니다.",
                                "가입 시 다른 사람의 정보를 도용하지 않아야 하며 계정과 비밀번호를 안전하게 관리해야 합니다.")),
                        new Section("서비스 이용", List.of(
                                "타인의 권리를 침해하거나 불법적인 콘텐츠를 게시·송출해서는 안 됩니다.",
                                "위법한 이용이나 서비스 운영을 방해하는 행위는 제한될 수 있습니다.")),
                        new Section("변경 및 안내", List.of(
                                "서비스 기능과 제공 범위는 변경될 수 있으며, 이용에 중요한 변경은 서비스 안에서 안내합니다.")))),
                "privacy", new Policy(PRIVACY_VERSION, "개인정보 수집·이용 동의", true, List.of(
                        new Section("수집·이용 목적", List.of(
                                "회원 식별과 로그인, 개인 채널 생성·관리, 팔로우 저장 및 약관 동의 이력 관리에 이용합니다.")),
                        new Section("수집 항목", List.of(
                                "이메일, 비밀번호의 단방향 해시, 닉네임, 채널 ID, 채널 설정, 팔로우 정보, 동의한 문서 버전과 동의 시각을 저장합니다.",
                                "닉네임, 채널 ID와 공개 채널 정보는 다른 이용자에게 표시됩니다.")),
                        new Section("보유·이용 기간", List.of("회원 탈퇴 또는 계정 삭제 시까지 보관합니다.")),
                        new Section("동의 거부 및 권리", List.of(
                                "개인정보 수집·이용에 동의하지 않을 수 있으나, 필수 정보 처리에 동의하지 않으면 회원가입이 제한됩니다.",
                                "본인의 개인정보에 대한 열람·정정·삭제 및 동의 철회를 요청할 수 있습니다.")))));
    }

    public static void requireConsent(JsonNode value) {
        if (!value.path("termsAccepted").isBoolean() || !value.path("termsAccepted").booleanValue()
                || !value.path("privacyAccepted").isBoolean() || !value.path("privacyAccepted").booleanValue())
            throw new ProductProblem(400, "CONSENT_REQUIRED", "이용약관과 개인정보 수집·이용에 동의해 주세요.");
        if (!value.path("termsVersion").isString() || !TERMS_VERSION.equals(value.path("termsVersion").asString())
                || !value.path("privacyVersion").isString() || !PRIVACY_VERSION.equals(value.path("privacyVersion").asString()))
            throw new ProductProblem(400, "CONSENT_VERSION_CHANGED", "약관 내용이 변경되었어요. 최신 내용을 확인한 뒤 다시 동의해 주세요.");
    }
}
