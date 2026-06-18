package com.jobpilot.config;

import com.jobpilot.security.ApiTokenFilter;
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
                    request.getHeaders().add("User-Agent", "JobPilot/0.1 (+personal-use)");
                    return execution.execute(request, body);
                })
                .build();
    }

    /** Register the static-token filter for /api/** only. */
    @Bean
    public FilterRegistrationBean<ApiTokenFilter> apiTokenFilter() {
        FilterRegistrationBean<ApiTokenFilter> reg = new FilterRegistrationBean<>();
        reg.setFilter(new ApiTokenFilter(props.getApiToken()));
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
        return patterns;
    }
}
