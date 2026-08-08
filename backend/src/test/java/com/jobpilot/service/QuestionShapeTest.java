package com.jobpilot.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * How a screening question is classified — which decides the instruction the model is given,
 * and therefore the shape of the answer that reaches a real employer's form.
 *
 * This had no coverage, and it is where the worst answer this project has produced came from.
 * A live run answered "How much exp do you have in docker" with "Yes", because the question
 * contains "do you have" and so matched the yes/no pattern, while the quantity pattern only
 * knew "how many". The model was told "Exactly one word: Yes or No" and obeyed. Nothing about
 * the model's understanding was at fault — it was handed the wrong contract.
 */
class QuestionShapeTest {

    private static void shape(AssistService.Shape expected, String question) {
        assertEquals(expected, AssistService.shapeOf(question, null), question);
    }

    @Test
    void quantityQuestionsAreNumbers_howeverTheEmployerPhrasesThem() {
        // Every one of these is real wording from a run.
        shape(AssistService.Shape.NUMBER, "How much exp do you have in docker");
        shape(AssistService.Shape.NUMBER, "What's your total IT exp");
        shape(AssistService.Shape.NUMBER, "How many years of work experience do you have with PL/SQL?");
        shape(AssistService.Shape.NUMBER, "yrs of exp in react");
        shape(AssistService.Shape.NUMBER, "How long have you worked with Kubernetes");
    }

    @Test
    void quantityBeatsYesNoWhenAQuestionReadsAsBoth() {
        // THE bug: "do you have" is in both. Quantity has to win, or the model is told to
        // answer Yes to a question asking for a number.
        shape(AssistService.Shape.NUMBER, "How much experience do you have with AWS?");
        shape(AssistService.Shape.NUMBER, "How many years of Java do you have?");
    }

    @Test
    void genuineYesNoQuestionsAreStillYesNo() {
        // The risk of widening the quantity pattern is stealing questions from other shapes.
        shape(AssistService.Shape.YES_NO, "Are you authorised to work in India?");
        shape(AssistService.Shape.YES_NO, "Do you require visa sponsorship?");
        shape(AssistService.Shape.YES_NO, "Are you willing to relocate?");
    }

    @Test
    void theOtherShapesAreUndisturbed() {
        shape(AssistService.Shape.URL, "LinkedIn profile URL");
        shape(AssistService.Shape.ESSAY, "Why do you want to work here?");
        shape(AssistService.Shape.VALUE, "Current company");
    }

    @Test
    void salaryAndNoticePeriodStayFreeText() {
        // Deliberately NOT numbers: "6.5 LPA" and "30 days" are the answers forms want, and
        // stripping them to a bare number loses the unit that makes them meaningful.
        shape(AssistService.Shape.VALUE, "Expected CTC");
        shape(AssistService.Shape.VALUE, "Notice period");
    }
}
