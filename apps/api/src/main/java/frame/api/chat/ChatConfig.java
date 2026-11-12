package frame.api.chat;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * The chat socket on /{path}/chat. Any origin may connect (the viewer UI is served by the front proxy or opened from the
 * sender's console) in relay-only mode. Product mode enforces its exact Origin in ChatGate and uses one-time account
 * tickets instead of WebSocket cookie access. Messages are capped at 16 KB.
 */
@Configuration
@EnableWebSocket
public class ChatConfig implements WebSocketConfigurer {
    private static final int MAX_MESSAGE = 16 * 1024;

    private final ChatSocket socket;
    private final ChatGate gate;

    public ChatConfig(ChatSocket socket, ChatGate gate) {
        this.socket = socket;
        this.gate = gate;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(socket, "/*/chat").addInterceptors(gate).setAllowedOriginPatterns("*");
    }

    @Bean
    public ServletServerContainerFactoryBean chatContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(MAX_MESSAGE);
        container.setMaxBinaryMessageBufferSize(MAX_MESSAGE);
        return container;
    }
}
