package frame.api.account;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import tools.jackson.databind.JsonNode;

/** Validation for the small, ordered public profile; links are never fetched by the server. */
final class ChannelProfile {
    record Link(String title, String url) {}
    private static final Set<String> COUNTRIES = Set.of(Locale.getISOCountries());
    private ChannelProfile() {}
    static String country(JsonNode value) {
        if (value.isNull()) return null;
        if (!value.isString()) throw invalidCountry();
        String code = value.asString().trim().toUpperCase(Locale.ROOT);
        if (!COUNTRIES.contains(code)) throw invalidCountry();
        return code;
    }
    static List<Link> links(JsonNode value) {
        if (!value.isArray() || value.size() > 14) throw invalidLinks();
        List<Link> links = new ArrayList<>();
        for (JsonNode item : value) {
            if (!item.isObject() || item.size() != 2 || !item.path("title").isString() || !item.path("url").isString()) throw invalidLinks();
            if (item.path("title").asString().codePoints().anyMatch(Character::isISOControl) || item.path("url").asString().codePoints().anyMatch(Character::isISOControl)) throw invalidLinks();
            String title = item.path("title").asString().strip(), url = item.path("url").asString().strip();
            if (Accounts.length(title) < 1 || Accounts.length(title) > 50 || title.codePoints().anyMatch(Character::isISOControl)
                    || url.length() > 500 || url.codePoints().anyMatch(Character::isISOControl)) throw invalidLinks();
            try {
                URI address = URI.create(url);
                if (!("https".equalsIgnoreCase(address.getScheme()) || "http".equalsIgnoreCase(address.getScheme()))
                        || address.getHost() == null || address.getHost().isBlank() || address.getRawUserInfo() != null
                        || (address.getPort() != -1 && (address.getPort() < 1 || address.getPort() > 65535))) throw invalidLinks();
            } catch (IllegalArgumentException failure) { throw invalidLinks(); }
            links.add(new Link(title, url));
        }
        return List.copyOf(links);
    }
    private static ProductProblem invalidCountry() { return new ProductProblem(400, "INVALID_COUNTRY", "국가를 다시 선택해 주세요."); }
    private static ProductProblem invalidLinks() { return new ProductProblem(400, "INVALID_CHANNEL_LINKS", "링크는 최대 14개, 제목은 1~50자, HTTP(S) 주소는 500자까지 입력해 주세요."); }
}
