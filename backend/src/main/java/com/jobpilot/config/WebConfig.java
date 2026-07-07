package com.jobpilot.config;

import com.jobpilot.security.AuthFilter;
import com.jobpilot.security.JwtService;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

import java.util.List;

@Configuration
public class WebConfig {

    private final JobPilotProperties props;

    public WebConfig(JobPilotProperties props) {
        this.props = props;
    }

    /** Shared HTTP client for all outbound connector calls. */
    @Bean
    public RestClient restClient() {
        return RestClient.builder()
                .requestInterceptor((request, body, execution) -> {
                    // Default UA only when the caller didn't set one (e.g. the LinkedIn
                    // guest search sends a browser UA — don't append a second value).
                    if (!request.getHeaders().containsKey("User-Agent")) {
                        request.getHeaders().add("User-Agent", "JobPilot/0.1 (+personal-use)");
                    }
                    return execution.execute(request, body);
                })
                .build();
    }

    /** Auth filter for /api/**: public /auth, admin routes by DB role, JWT for user routes. */
    @Bean
    public FilterRegistrationBean<AuthFilter> authFilter(JwtService jwt,
                                                         com.jobpilot.repository.AppUserRepository users) {
        FilterRegistrationBean<AuthFilter> reg = new FilterRegistrationBean<>();
        reg.setFilter(new AuthFilter(props.getApiToken(), jwt, users));
        reg.addUrlPatterns("/api/*");
        reg.setOrder(1);
        return reg;
    }

    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter() {
        CorsConfiguration cfg = new CorsConfiguration();
        // Allow configured dashboard origins + any chrome extension origin.
        cfg.setAllowedOriginPatterns(buildPatterns());
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setAllowCredentials(false);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        
        FilterRegistrationBean<CorsFilter> reg = new FilterRegistrationBean<>(new CorsFilter(source));
        reg.setOrder(org.springframework.core.Ordered.HIGHEST_PRECEDENCE);
        return reg;
    }

    private List<String> buildPatterns() {
        List<String> patterns = new java.util.ArrayList<>(props.getCorsOrigins());
        patterns.add("chrome-extension://*");
        patterns.add("https://*.vercel.app");   // any Vercel deployment of this app
        // Auth is via the Authorization/X-Api-Token header (no cookies), so allowing
        // all origins is safe and avoids per-deploy CORS breakage.
        patterns.add("*");
        return patterns;
    }
}
