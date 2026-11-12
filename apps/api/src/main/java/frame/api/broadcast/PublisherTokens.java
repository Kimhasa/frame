package frame.api.broadcast;

import frame.api.FrameProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Publisher tokens and the stream paths each may use (RELAY_PUBLISHER_TOKENS / RELAY_PUBLISHER_TOKENS_FILE): one entry
 * per sender PC, "<token> <path> [<path> ...]" ("*" = any path, test setups only). Kept only as SHA-256 digests, so a heap
 * dump or a log line never contains a token.
 */
@Component
public class PublisherTokens {
    private static final Pattern BEARER = Pattern.compile("^Bearer ([^\\s]{1,512})$");
    private final List<byte[]> digests = new ArrayList<>();
    /** Paths per token; null = any path. */
    private final List<Set<String>> paths = new ArrayList<>();

    public PublisherTokens(FrameProperties props) throws IOException {
        List<String> entries = new ArrayList<>();
        if (props.publisherTokens() != null)
            for (String e : props.publisherTokens().split(",")) if (!e.isBlank()) entries.add(e.trim());
        if (props.publisherTokensFile() != null && !props.publisherTokensFile().isBlank())
        {
            // Read as the Node relay does: malformed bytes replaced (a comment in another code page does not stop startup),
            // a UTF-8 byte order mark (PowerShell's Set-Content -Encoding UTF8 writes one) not part of the first token.
            String text = new String(Files.readAllBytes(Path.of(props.publisherTokensFile())), StandardCharsets.UTF_8);
            if (text.startsWith("﻿")) text = text.substring(1);
            for (String line : text.split("\\r?\\n")) {
                String t = line.strip();
                if (!t.isEmpty() && !t.startsWith("#")) entries.add(t);
            }
        }
        for (String entry : entries) {
            String[] parts = entry.split("\\s+");
            String token = parts[0];
            if (token.length() < 24) throw new IllegalArgumentException("publisher tokens must be at least 24 characters without spaces or commas");
            if (parts.length < 2) throw new IllegalArgumentException("each publisher token needs its path(s): \"<token> <path> [<path> ...]\" (or \"*\" for any path)");
            List<String> assigned = Arrays.asList(parts).subList(1, parts.length);
            for (String p : assigned)
                if (!p.equals("*") && !Announcement.PATH.matcher(p).matches()) throw new IllegalArgumentException("publisher token path \"" + p + "\" is not a valid stream path");
            digests.add(sha256(token));
            paths.add(assigned.contains("*") ? null : new HashSet<>(assigned));
        }
    }

    public int size() { return digests.size(); }

    /** Index of the token in an "Authorization: Bearer ..." header, or -1. Every digest is compared (time independent of which). */
    public int indexOf(String authorization) {
        if (authorization == null) return -1;
        Matcher m = BEARER.matcher(authorization);
        if (!m.matches()) return -1;
        byte[] digest = sha256(m.group(1));
        int found = -1;
        for (int i = 0; i < digests.size(); i++) if (MessageDigest.isEqual(digests.get(i), digest) && found < 0) found = i;
        return found;
    }

    public boolean allows(int token, String path) {
        Set<String> p = paths.get(token);
        return p == null || p.contains(path);
    }

    /** Tokens that may announce any path ("*"). */
    public long anyPath() { return paths.stream().filter(p -> p == null).count(); }

    /** One explicitly assigned owner, or -1 for unassigned/ambiguous paths. Wildcard test tokens never claim OBS input. */
    public int explicitOwner(String path) {
        int owner = -1;
        for (int i = 0; i < paths.size(); i++) {
            Set<String> assigned = paths.get(i);
            if (assigned == null || !assigned.contains(path)) continue;
            if (owner >= 0) return -1;
            owner = i;
        }
        return owner;
    }

    private static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
