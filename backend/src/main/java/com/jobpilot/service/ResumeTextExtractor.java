package com.jobpilot.service;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;

/** Extracts plain text from a PDF or DOCX resume for AI parsing. */
@Service
public class ResumeTextExtractor {

    public String extract(MultipartFile file) {
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase();
        try (InputStream in = file.getInputStream()) {
            if (name.endsWith(".pdf")) {
                try (PDDocument doc = Loader.loadPDF(in.readAllBytes())) {
                    return new PDFTextStripper().getText(doc);
                }
            } else if (name.endsWith(".docx")) {
                try (XWPFDocument doc = new XWPFDocument(in);
                     XWPFWordExtractor ex = new XWPFWordExtractor(doc)) {
                    return ex.getText();
                }
            } else {
                return new String(in.readAllBytes());
            }
        } catch (Exception e) {
            throw new IllegalStateException("could not read resume text: " + e.getMessage(), e);
        }
    }
}
