import {HttpClient} from '@angular/common/http';
import {ChangeDetectorRef, Component, Inject, OnDestroy, OnInit, QueryList, TemplateRef, ViewChild, ViewChildren} from '@angular/core';
import {UntypedFormControl} from '@angular/forms';
import {Title} from '@angular/platform-browser';
import {Router} from '@angular/router';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {filter, map, take, timeout} from 'rxjs/operators';
import {ChatRequest, ChatRoomInfo, ChatService} from '../../../openapi';
import {AlertService} from '../alert';
import {AuthService} from '../authentication.service';
import {CommonService} from '../common.service';
import {PaneLog} from '../new_data';
import {ChatPaneComponent} from '../chat-pane/chat-pane.component';
import {answersMatch, EvaluationQuestion, parseQuestionsFile} from './questions-parser';
import {createZipBlob} from './zip-store';

interface BotCredential {
  username: string
  password: string
}

interface EvalChat {
  username: string
  password: string
  paneLog: PaneLog
  lastVerdict: 'correct' | 'incorrect' | 'timeout' | null
  lastResponseMs: number | null
  correctOrdinals: number[]
}

interface EvaluationResult {
  username: string
  roomId: string
  questionIndex: number
  question: string
  expected: string
  answer: string
  correct: boolean
  timedOut: boolean
  responseTimeMs: number | null
}

interface ChatRanking {
  rank: number
  username: string
  roomId: string
  correct: number
  incorrect: number
  timeouts: number
  total: number
  accuracy: number
  grade: number
  avgResponseTimeMs: number | null
  totalResponseTimeMs: number
}

interface QuestionScore {
  verdict: 'correct' | 'incorrect' | 'timeout' | null
  timeMs: number | null
  fastBonus: boolean
}

interface ChatScoreRow {
  username: string
  roomId: string
  answers: QuestionScore[]
  avgMs: number | null
  fastestMs: number | null
  fastestQuestion: number | null
  longestMs: number | null
  longestQuestion: number | null
  grade: number
}

interface EvaluationLogEntry {
  time: Date
  level: 'info' | 'success' | 'warning' | 'danger'
  message: string
  username?: string
  roomId?: string
}

@Component({
  selector: 'app-automated-evaluation',
  templateUrl: './automated-evaluation.component.html',
  styleUrls: ['./automated-evaluation.component.css']
})
export class AutomatedEvaluationComponent implements OnInit, OnDestroy {
  options = {
    autoClose: true,
    keepAfterRouteChange: true
  };

  @ViewChild('resultModal') resultModal!: TemplateRef<any>;
  @ViewChild('questionsModal') questionsModal!: TemplateRef<any>;
  @ViewChildren(ChatPaneComponent) chatPanes!: QueryList<ChatPaneComponent>;

  credentialsInput = new UntypedFormControl('');
  chats: EvalChat[] = [];
  questions: EvaluationQuestion[] = [];
  results: EvaluationResult[] = [];
  logs: EvaluationLogEntry[] = [];

  startingChats = false;
  askingQuestions = false;
  closingChats = false;
  downloadingChats = false;
  downloadingSummary = false;
  finishing = false;
  currentQuestionLabel = '';
  selectedRoomID = '';
  selectedLogChat = '';

  private stopAsking = false;
  private readonly answerTimeoutMs = 45000;
  private readonly roomTimeoutMs = 15000;
  private readonly correctPoints = 1;
  private readonly fastBonusPoints = 0.2;
  private readonly fastThresholdMs = 3000;
  private readonly ultraFastThresholdMs = 200;

  constructor(
    private router: Router,
    private titleService: Title,
    private http: HttpClient,
    private authService: AuthService,
    @Inject(CommonService) private commonService: CommonService,
    @Inject(ChatService) private chatService: ChatService,
    public alertService: AlertService,
    private modalService: NgbModal,
    private changeDetector: ChangeDetectorRef
  ) {
  }

  ngOnInit(): void {
    this.titleService.setTitle('Automated Evaluation');
    this.authService.userSessionDetails.subscribe((response) => {
      if (response == null) {
        this.router.navigateByUrl('/login').then(() => this.alertService.error('You are not logged in!'));
        return;
      }
      if (response.userDetails.role !== 'ADMIN') {
        this.router.navigateByUrl('/panel').then(() => this.alertService.error('Automated evaluation is only available to admins.'));
      }
    });

    this.commonService.openSseAndListenRooms(false);
    this.loadQuestions();
  }

  get canStartChats(): boolean {
    return !this.startingChats && !this.askingQuestions && !!this.credentialsInput.value;
  }

  get canAskQuestions(): boolean {
    return !this.startingChats && !this.askingQuestions && this.chats.length > 0 && this.questions.length > 0 && this.hasActiveChats;
  }

  get canFinish(): boolean {
    return !this.startingChats && (this.chats.length > 0 || this.results.length > 0);
  }

  get canSeeQuestions(): boolean {
    return this.questions.length > 0;
  }

  get canCloseChats(): boolean {
    return !this.startingChats && !this.closingChats && this.hasActiveChats;
  }

  get canDownloadChats(): boolean {
    return !this.downloadingChats && this.chats.length > 0;
  }

  get canDownloadSummary(): boolean {
    return !this.downloadingSummary && this.chatScoreRows.length > 0;
  }

  get filteredLogs(): EvaluationLogEntry[] {
    const roomId = this.activeLogRoomId;
    if (!roomId) {
      return [];
    }
    const chat = this.chats.find(item => item.paneLog.roomID === roomId);
    return this.logs.filter(entry =>
      entry.roomId === roomId ||
      (!entry.roomId && !!chat && entry.username === chat.username)
    );
  }

  get activeLogRoomId(): string {
    if (this.chats.some(chat => chat.paneLog.roomID === this.selectedLogChat)) {
      return this.selectedLogChat;
    }
    return this.chats[0]?.paneLog.roomID || '';
  }

  selectLogChat(roomId: string): void {
    this.selectedLogChat = roomId;
  }

  get chatScoreRows(): ChatScoreRow[] {
    return this.chats.map(chat => {
      const chatResults = this.results.filter(r => r.roomId === chat.paneLog.roomID);
      const byQuestion = new Map(chatResults.map(result => [result.questionIndex, result]));
      const timed = chatResults.filter(result => !result.timedOut && result.responseTimeMs != null);
      const fastest = timed.reduce<EvaluationResult | null>((best, result) => {
        if (!best || (result.responseTimeMs as number) < (best.responseTimeMs as number)) {
          return result;
        }
        return best;
      }, null);
      const longest = timed.reduce<EvaluationResult | null>((best, result) => {
        if (!best || (result.responseTimeMs as number) > (best.responseTimeMs as number)) {
          return result;
        }
        return best;
      }, null);

      return {
        username: chat.username,
        roomId: chat.paneLog.roomID,
        answers: this.questions.map(question => {
          const result = byQuestion.get(question.index);
          if (!result) {
            return {verdict: null, timeMs: null, fastBonus: false};
          }
          let verdict: QuestionScore['verdict'] = result.correct ? 'correct' : 'incorrect';
          if (result.timedOut) {
            verdict = 'timeout';
          }
          return {
            verdict,
            timeMs: result.responseTimeMs,
            fastBonus: this.hasFastBonus(result)
          };
        }),
        avgMs: this.averageTime(chatResults),
        fastestMs: fastest?.responseTimeMs ?? null,
        fastestQuestion: fastest ? fastest.questionIndex + 1 : null,
        longestMs: longest?.responseTimeMs ?? null,
        longestQuestion: longest ? longest.questionIndex + 1 : null,
        grade: this.gradeForResults(chatResults)
      };
    });
  }

  get hasActiveChats(): boolean {
    return this.chats.some(chat => chat.paneLog.active);
  }

  get totalAsked(): number {
    return this.results.length;
  }

  get totalCorrect(): number {
    return this.results.filter(r => r.correct).length;
  }

  get totalIncorrect(): number {
    return this.results.filter(r => !r.correct && !r.timedOut).length;
  }

  get totalTimeouts(): number {
    return this.results.filter(r => r.timedOut).length;
  }

  get accuracyPercent(): number {
    if (this.totalAsked === 0) {
      return 0;
    }
    return Math.round((this.totalCorrect / this.totalAsked) * 100);
  }

  get overallAvgResponseTimeMs(): number | null {
    return this.averageTime(this.results);
  }

  get rankedChats(): ChatRanking[] {
    const rows: ChatRanking[] = this.chats.map(chat => {
      const chatResults = this.results.filter(r => r.roomId === chat.paneLog.roomID);
      const answeredTimes = chatResults
        .filter(r => !r.timedOut && r.responseTimeMs != null)
        .map(r => r.responseTimeMs as number);
      const correct = chatResults.filter(r => r.correct).length;
      const timeouts = chatResults.filter(r => r.timedOut).length;
      const total = chatResults.length;
      return {
        rank: 0,
        username: chat.username,
        roomId: chat.paneLog.roomID,
        correct,
        incorrect: chatResults.filter(r => !r.correct && !r.timedOut).length,
        timeouts,
        total,
        accuracy: total === 0 ? 0 : Math.round((correct / total) * 100),
        grade: this.gradeForResults(chatResults),
        avgResponseTimeMs: answeredTimes.length === 0
          ? null
          : answeredTimes.reduce((sum, time) => sum + time, 0) / answeredTimes.length,
        totalResponseTimeMs: answeredTimes.reduce((sum, time) => sum + time, 0)
      };
    });

    rows.sort((a, b) => {
      if (b.grade !== a.grade) {
        return b.grade - a.grade;
      }
      if (b.correct !== a.correct) {
        return b.correct - a.correct;
      }
      if (a.timeouts !== b.timeouts) {
        return a.timeouts - b.timeouts;
      }
      const aTime = a.avgResponseTimeMs ?? Number.POSITIVE_INFINITY;
      const bTime = b.avgResponseTimeMs ?? Number.POSITIVE_INFINITY;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      return a.username.localeCompare(b.username);
    });

    let previousKey = '';
    let previousRank = 0;
    rows.forEach((row, index) => {
      const key = `${row.grade}|${row.correct}|${row.timeouts}|${row.avgResponseTimeMs ?? 'na'}`;
      if (key === previousKey) {
        row.rank = previousRank;
      } else {
        row.rank = index + 1;
        previousRank = row.rank;
        previousKey = key;
      }
    });
    return rows;
  }

  formatResponseTime(ms: number | null | undefined): string {
    if (ms == null) {
      return '—';
    }
    return `${(ms / 1000).toFixed(3)}s`;
  }

  formatGrade(grade: number | null | undefined): string {
    if (grade == null) {
      return '—';
    }
    return grade.toFixed(1);
  }

  gradeFor(chat: EvalChat): number {
    return this.gradeForResults(this.results.filter(result => result.roomId === chat.paneLog.roomID));
  }

  rankFor(chat: EvalChat): number | null {
    const row = this.rankedChats.find(stat => stat.roomId === chat.paneLog.roomID);
    return row && row.total > 0 ? row.rank : null;
  }

  isChatFinished(chat: EvalChat): boolean {
    if (this.questions.length === 0) {
      return false;
    }
    const lastIndex = this.questions[this.questions.length - 1].index;
    return this.results.some(result => result.roomId === chat.paneLog.roomID && result.questionIndex === lastIndex);
  }

  scoreRatioFor(chat: EvalChat): string | null {
    const chatResults = this.results.filter(result => result.roomId === chat.paneLog.roomID);
    if (chatResults.length === 0) {
      return null;
    }
    const correct = chatResults.filter(result => result.correct).length;
    return `${correct}/${chatResults.length}`;
  }

  startChats(): void {
    const credentials = this.parseCredentials(this.credentialsInput.value || '');
    if (credentials.length === 0) {
      this.alertService.error('Enter credentials as bot1 pass1, bot2 pass2.', this.options);
      return;
    }

    this.startingChats = true;
    this.stopAsking = false;
    this.log('info', `Starting ${credentials.length} chat${credentials.length === 1 ? '' : 's'}...`);
    this.createChatsSequentially(credentials).finally(() => {
      this.startingChats = false;
    });
  }

  importCredentialsFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const credentials = this.parseImportedCredentials(String(reader.result || ''));
      if (credentials.length === 0) {
        this.alertService.error('No botname-password pairs found in the file.', this.options);
        return;
      }
      this.credentialsInput.setValue(credentials.map(cred => `${cred.username} ${cred.password}`).join(', '));
      this.log('success', `Imported ${credentials.length} bot${credentials.length === 1 ? '' : 's'} from ${file.name}.`);
      this.alertService.success(`Imported ${credentials.length} bot credential${credentials.length === 1 ? '' : 's'}.`, this.options);
    };
    reader.onerror = () => {
      this.alertService.error('Could not read the text file.', this.options);
    };
    reader.readAsText(file);
  }

  askQuestions(): void {
    if (this.startingChats || this.askingQuestions || this.chats.length === 0 || !this.hasActiveChats) {
      return;
    }
    this.loadQuestions().then(() => {
      if (this.questions.length === 0) {
        this.alertService.error('No questions loaded.', this.options);
        return;
      }
      this.askingQuestions = true;
      this.stopAsking = false;
      this.log('info', `Asking ${this.questions.length} questions in order...`);
      return this.askNextQuestion(0);
    }).then(() => {
      if (!this.askingQuestions) {
        return;
      }
      this.askingQuestions = false;
      this.currentQuestionLabel = '';
      if (this.stopAsking) {
        this.chats.forEach(chat => this.log('warning', 'Question round was stopped.', chat.username, chat.paneLog.roomID));
        return;
      }
      this.chats.forEach(chat => this.log('success', 'All questions were sent and scored.', chat.username, chat.paneLog.roomID));
      this.alertService.success('Question round finished. You can now finish the evaluation.', this.options);
    }).catch((error) => {
      this.askingQuestions = false;
      this.currentQuestionLabel = '';
      this.log('danger', `Question round failed: ${error?.message || error}`);
      this.alertService.error('Could not complete the question round.', this.options);
    });
  }

  seeQuestions(): void {
    this.loadQuestions().then(() => {
      if (this.questions.length === 0) {
        this.alertService.error('Questions are not loaded yet.', this.options);
        return;
      }
      this.modalService.open(this.questionsModal, {size: 'lg', centered: true, scrollable: true});
    }).catch(() => {
      this.alertService.error('Could not load automated-evaluation-questions.txt.', this.options);
    });
  }

  closeChats(): void {
    if (!this.canCloseChats) {
      return;
    }
    this.stopAsking = true;
    this.closingChats = true;
    const activeChats = this.chats.filter(chat => chat.paneLog.active);
    Promise.all(activeChats.map(chat =>
      this.chatService.patchApiRoomByRoomId(chat.paneLog.roomID, undefined).toPromise()
        .then(() => this.markEvalChatClosed(chat))
        .catch(() => this.markEvalChatClosed(chat))
    )).then(() => {
      this.log('success', `Closed ${activeChats.length} chat${activeChats.length === 1 ? '' : 's'}.`);
      this.alertService.success('Chats closed.', this.options);
      this.changeDetector.detectChanges();
    }).finally(() => {
      this.closingChats = false;
      this.changeDetector.detectChanges();
    });
  }

  onPaneClosed(chat: EvalChat): void {
    this.markEvalChatClosed(chat);
    this.changeDetector.detectChanges();
  }

  private markEvalChatClosed(chat: EvalChat): void {
    chat.paneLog.active = false;
    const pane = this.chatPanes?.find(item => item.paneLog.roomID === chat.paneLog.roomID);
    pane?.markClosed();
  }

  finishEvaluation(): void {
    this.stopAsking = true;
    this.finishing = true;
    this.selectedLogChat = this.chats[0]?.paneLog.roomID || '';
    this.modalService.open(this.resultModal, {
      size: 'xl',
      centered: true,
      scrollable: true,
      windowClass: 'eval-result-modal'
    });
    this.finishing = false;
  }

  downloadChats(): void {
    if (!this.canDownloadChats) {
      return;
    }
    this.downloadingChats = true;
    try {
      const usedNames = new Set<string>();
      const files = this.chats.map(chat => {
        const base = this.safeFileName(chat.username);
        let name = `${base}.txt`;
        let suffix = 2;
        while (usedNames.has(name)) {
          name = `${base}-${suffix}.txt`;
          suffix += 1;
        }
        usedNames.add(name);
        return {name, content: this.buildChatExport(chat)};
      });
      const blob = createZipBlob(files);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      link.href = url;
      link.download = `automated-evaluation-chats-${stamp}.zip`;
      link.click();
      window.URL.revokeObjectURL(url);
      this.log('success', 'Chat transcripts downloaded.');
    } catch (error) {
      this.alertService.error('Could not download chats.', this.options);
    } finally {
      this.downloadingChats = false;
    }
  }

  downloadSummary(): void {
    if (!this.canDownloadSummary) {
      return;
    }
    this.downloadingSummary = true;
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      this.triggerDownload(`automated-evaluation-summary-${stamp}.pdf`, this.buildSummaryPdf());
    } catch (error) {
      this.alertService.error('Could not download the summary.', this.options);
    } finally {
      this.downloadingSummary = false;
    }
  }

  scrollTo(id: string): void {
    const pane = document.querySelector('#evalchat' + id);
    if (pane) {
      pane.scrollIntoView({block: 'nearest', inline: 'center', behavior: 'smooth'});
    }
  }

  ngOnDestroy(): void {
    this.stopAsking = true;
  }

  private loadQuestions(): Promise<void> {
    const url = `/api/automated-evaluation/questions?t=${Date.now()}`;
    return this.http.get(url, {responseType: 'text', withCredentials: true}).toPromise()
      .catch(() => this.http.get(`/assets/automated-evaluation-questions.txt?t=${Date.now()}`, {responseType: 'text'}).toPromise())
      .then((raw) => {
        if (!raw) {
          throw new Error('The questions file is empty.');
        }
        this.questions = parseQuestionsFile(raw);
        this.log('info', `Loaded ${this.questions.length} questions from automated-evaluation-questions.txt.`);
      })
      .catch((error) => {
        this.alertService.error(error.message || 'Could not load automated-evaluation-questions.txt.', this.options);
        throw error;
      });
  }

  private parseCredentials(raw: string): BotCredential[] {
    return raw
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
      .map(part => {
        const separator = part.search(/\s+/);
        if (separator <= 0) {
          return {username: '', password: ''};
        }
        return {
          username: part.slice(0, separator).trim(),
          password: part.slice(separator).trim()
        };
      })
      .filter(cred => cred.username.length > 0 && cred.password.length > 0);
  }

  private parseImportedCredentials(raw: string): BotCredential[] {
    return raw
      .split(/[\n,]/)
      .map(part => part.trim())
      .filter(part => part.length > 0 && !part.startsWith('#'))
      .map(part => {
        const separator = part.indexOf('-');
        if (separator <= 0 || separator === part.length - 1) {
          return {username: '', password: ''};
        }
        return {
          username: part.slice(0, separator).trim(),
          password: part.slice(separator + 1).trim()
        };
      })
      .filter(cred => cred.username.length > 0 && cred.password.length > 0);
  }

  private async createChatsSequentially(credentials: BotCredential[]): Promise<void> {
    for (const credential of credentials) {
      try {
        const knownIds = await this.snapshotRoomIds();
        await this.chatService.postApiRoomsRequest({
          username: credential.username,
          formName: '',
          automatedEvaluation: true
        } as ChatRequest).toPromise();
        const room = await this.waitForNewRoom(knownIds);
        this.addChat(room, credential);
      } catch (error: any) {
        if (error?.status === 404) {
          this.log('danger', `User ${credential.username} does not exist.`, credential.username);
          this.alertService.error(`User ${credential.username} does not exist.`, this.options);
        } else if (error?.status === 403) {
          this.log('danger', 'Cannot start a chat while an assignment round is running.');
          this.alertService.error('Cannot start a chat while an assignment round is running.', this.options);
        } else if (error?.name === 'TimeoutError') {
          this.log('danger', `Timed out waiting for a room with ${credential.username}.`, credential.username);
        } else {
          this.log('danger', `Could not start a chat with ${credential.username}.`, credential.username);
          this.alertService.error(`Could not start a chat with ${credential.username}.`, this.options);
        }
      }
    }
    this.log('success', `Started ${this.chats.length} chat${this.chats.length === 1 ? '' : 's'}.`);
    if (this.chats.length > 0) {
      this.alertService.success('Chats started. You can scroll through them below.', this.options);
    }
  }

  private snapshotRoomIds(): Promise<Set<string>> {
    return this.commonService.Rooms.pipe(take(1)).toPromise().then(list => {
      const ids = new Set(this.chats.map(chat => chat.paneLog.roomID));
      list?.rooms.forEach(room => ids.add(room.uid));
      return ids;
    });
  }

  private waitForNewRoom(knownIds: Set<string>): Promise<ChatRoomInfo> {
    return this.commonService.Rooms.pipe(
      filter(list => !!list && list.rooms.some(room => !knownIds.has(room.uid))),
      map(list => list!.rooms.find(room => !knownIds.has(room.uid))!),
      take(1),
      timeout(this.roomTimeoutMs)
    ).toPromise() as Promise<ChatRoomInfo>;
  }

  private addChat(room: ChatRoomInfo, credential: BotCredential): void {
    if (this.chats.some(chat => chat.paneLog.roomID === room.uid)) {
      return;
    }
    if (this.selectedRoomID === '') {
      this.selectedRoomID = room.uid;
    }
    if (this.selectedLogChat === '') {
      this.selectedLogChat = room.uid;
    }
    const paneLog: PaneLog = {
      assignment: room.assignment,
      formRef: room.formRef,
      markAsNoFeedback: room.markAsNoFeedback,
      roomID: room.uid,
      ordinals: 0,
      messageLog: {},
      ratingOpen: false,
      active: true,
      ratings: {},
      myAlias: room.userAliases.find(a => a == room.alias) || '',
      otherAlias: room.userAliases.find(a => a != room.alias) || '',
      prompt: room.prompt,
      spectate: false,
      testerBotAlias: room.testerBotAlias
    };
    this.chats.unshift({
      username: credential.username,
      password: credential.password,
      paneLog,
      lastVerdict: null,
      lastResponseMs: null,
      correctOrdinals: []
    });
    this.log('success', `Chat started with ${credential.username} (${paneLog.otherAlias}).`, credential.username, room.uid);
  }

  private async askNextQuestion(questionIndex: number): Promise<void> {
    if (this.stopAsking || questionIndex >= this.questions.length) {
      return;
    }
    const item = this.questions[questionIndex];
    this.currentQuestionLabel = `Q${item.index + 1}: ${item.question}`;
    this.chats.forEach(chat => {
      this.log('info', `Sending question ${item.index + 1}: ${item.question}`, chat.username, chat.paneLog.roomID);
    });

    await Promise.all(this.chats.map(chat => this.askChatQuestion(chat, item)));
    await this.askNextQuestion(questionIndex + 1);
  }

  private async askChatQuestion(chat: EvalChat, item: EvaluationQuestion): Promise<void> {
    if (this.stopAsking) {
      return;
    }
    if (!chat.paneLog.active) {
      this.recordResult(chat, item, '', false, true, null);
      this.log('warning', `${chat.username}: room is no longer active, skipped question ${item.index + 1}.`, chat.username, chat.paneLog.roomID);
      return;
    }

    const beforeOrdinal = this.lastOtherOrdinal(chat);
    try {
      await this.chatService.postApiRoomByRoomId(chat.paneLog.roomID, undefined, '', item.question).toPromise();
    } catch (error) {
      this.recordResult(chat, item, '', false, true, null);
      this.log('danger', `${chat.username}: failed to send question ${item.index + 1}.`, chat.username, chat.paneLog.roomID);
      return;
    }

    const startedAt = Date.now();
    try {
      const reply = await this.waitForReply(chat, beforeOrdinal);
      const responseTimeMs = Date.now() - startedAt;
      const correct = answersMatch(item.expectedAnswer, reply.message);
      this.recordResult(chat, item, reply.message, correct, false, responseTimeMs);
      chat.lastVerdict = correct ? 'correct' : 'incorrect';
      chat.lastResponseMs = responseTimeMs;
      if (correct) {
        chat.correctOrdinals = chat.correctOrdinals.concat(reply.ordinal);
      }
      this.log(correct ? 'success' : 'warning',
        `${chat.username} Q${item.index + 1}: ${correct ? 'correct' : 'incorrect'} in ${this.formatResponseTime(responseTimeMs)} — "${this.shorten(reply.message)}"`,
        chat.username, chat.paneLog.roomID);
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      this.recordResult(chat, item, '', false, true, responseTimeMs);
      chat.lastVerdict = 'timeout';
      chat.lastResponseMs = responseTimeMs;
      this.log('warning', `${chat.username} Q${item.index + 1}: no answer within ${this.formatResponseTime(responseTimeMs)}.`, chat.username, chat.paneLog.roomID);
    }
  }

  private waitForReply(chat: EvalChat, afterOrdinal: number): Promise<{message: string, ordinal: number}> {
    return this.commonService.getChatStatusByRoomId(chat.paneLog.roomID).pipe(
      filter(state => {
        if (!state) {
          return false;
        }
        return state.messages.some(message =>
          message.authorAlias !== chat.paneLog.myAlias && message.ordinal > afterOrdinal);
      }),
      map(state => {
        const replies = state!.messages.filter(message =>
          message.authorAlias !== chat.paneLog.myAlias && message.ordinal > afterOrdinal);
        const last = replies[replies.length - 1];
        return {message: last.message, ordinal: last.ordinal};
      }),
      take(1),
      timeout(this.answerTimeoutMs)
    ).toPromise() as Promise<{message: string, ordinal: number}>;
  }

  private lastOtherOrdinal(chat: EvalChat): number {
    let last = -1;
    for (let i = 0; i < chat.paneLog.ordinals; i++) {
      const message = chat.paneLog.messageLog[i];
      if (message && !message.myMessage) {
        last = Math.max(last, message.ordinal);
      }
    }
    return last;
  }

  private recordResult(
    chat: EvalChat,
    item: EvaluationQuestion,
    answer: string,
    correct: boolean,
    timedOut: boolean,
    responseTimeMs: number | null
  ): void {
    this.results.push({
      username: chat.username,
      roomId: chat.paneLog.roomID,
      questionIndex: item.index,
      question: item.question,
      expected: item.expectedAnswer,
      answer,
      correct,
      timedOut,
      responseTimeMs
    });
  }

  private averageTime(results: EvaluationResult[]): number | null {
    const times = results
      .filter(result => !result.timedOut && result.responseTimeMs != null)
      .map(result => result.responseTimeMs as number);
    if (times.length === 0) {
      return null;
    }
    return times.reduce((sum, time) => sum + time, 0) / times.length;
  }

  private gradeForResults(results: EvaluationResult[]): number {
    return results.reduce((sum, result) => sum + this.pointsForResult(result), 0);
  }

  private pointsForResult(result: EvaluationResult): number {
    if (result.timedOut) {
      return 0;
    }
    let points = 0;
    if (result.correct) {
      points += this.correctPoints;
    }
    if (this.hasFastBonus(result)) {
      points += this.fastBonusPoints;
    }
    return points;
  }

  private hasFastBonus(result: EvaluationResult): boolean {
    if (result.timedOut || result.responseTimeMs == null) {
      return false;
    }
    if (result.responseTimeMs < this.ultraFastThresholdMs) {
      return true;
    }
    return result.correct && result.responseTimeMs < this.fastThresholdMs;
  }

  private log(level: EvaluationLogEntry['level'], message: string, username?: string, roomId?: string): void {
    this.logs.unshift({time: new Date(), level, message, username, roomId});
  }

  private triggerDownload(filename: string, blob: Blob): void {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  private buildSummaryPdf(): Blob {
    const header = [
      'Chat',
      ...this.questions.map(item => `Q${item.index + 1}`),
      'Average',
      'Fastest',
      'Longest',
      'Grade'
    ];
    const rows = this.chatScoreRows.map(row => [
      row.username,
      ...row.answers.map(answer => {
        const verdict = answer.verdict ?? '-';
        const time = answer.timeMs == null ? '' : this.formatResponseTime(answer.timeMs);
        const bonus = answer.fastBonus ? ' +0.2' : '';
        return `${verdict} ${time}${bonus}`.trim();
      }),
      this.formatResponseTime(row.avgMs),
      this.formatTimedQuestion(row.fastestMs, row.fastestQuestion),
      this.formatTimedQuestion(row.longestMs, row.longestQuestion),
      this.formatGrade(row.grade)
    ]);
    const lines = [
      'Automated evaluation summary',
      '1 point per correct. +0.2 if correct and under 3s, or if any reply is under 0.2s.',
      '',
      header.join(' | '),
      ...rows.map(row => row.join(' | '))
    ];
    return this.createSimplePdf(lines);
  }

  private createSimplePdf(lines: string[]): Blob {
    const escapePdf = (value: string) => value
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E]/g, '?');
    const commands = lines.map((line, index) => {
      const y = 560 - index * 14;
      return `BT /F1 9 Tf 30 ${y} Td (${escapePdf(line)}) Tj ET`;
    }).join('\n');
    const stream = commands + '\n';
    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
      `5 0 obj << /Length ${stream.length} >> stream\n${stream}endstream\nendobj\n`
    ];
    let body = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach(object => {
      offsets.push(body.length);
      body += object;
    });
    const xrefStart = body.length;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i++) {
      xref += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`;
    }
    body += xref;
    body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return new Blob([body], {type: 'application/pdf'});
  }

  private shorten(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
  }

  private safeFileName(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'chat';
  }

  private buildChatExport(chat: EvalChat): string {
    const lines: string[] = [
      `Chat: ${chat.username}`,
      `Room ID: ${chat.paneLog.roomID}`,
      '',
      '=== Conversation ==='
    ];

    for (let i = 0; i < chat.paneLog.ordinals; i++) {
      const message = chat.paneLog.messageLog[i];
      if (!message) {
        continue;
      }
      const speaker = message.myMessage ? 'admin' : chat.username;
      lines.push(`[${this.formatClock(message.time)}] ${speaker}: ${message.message}`);
    }

    if (chat.paneLog.ordinals === 0) {
      lines.push('(no messages)');
    }

    const chatResults = this.results
      .filter(result => result.roomId === chat.paneLog.roomID)
      .sort((a, b) => a.questionIndex - b.questionIndex);

    lines.push('', '=== Evaluation ===');
    if (chatResults.length === 0) {
      lines.push('(no scored questions)');
    } else {
      chatResults.forEach(result => {
        lines.push(
          `Q${result.questionIndex + 1}: ${result.question}`,
          `Expected: ${result.expected}`,
          `Answer: ${result.timedOut ? '(no answer)' : result.answer}`,
          `Result: ${result.timedOut ? 'TIMEOUT' : (result.correct ? 'CORRECT' : 'INCORRECT')}`,
          `Response time: ${this.formatResponseTime(result.responseTimeMs)}`,
          `Points: ${this.formatGrade(this.pointsForResult(result))}`,
          ''
        );
      });
    }

    const row = this.chatScoreRows.find(score => score.roomId === chat.paneLog.roomID);
    lines.push('=== Timing summary ===');
    lines.push(`Average: ${this.formatResponseTime(row?.avgMs ?? null)}`);
    lines.push(`Fastest: ${this.formatTimedQuestion(row?.fastestMs ?? null, row?.fastestQuestion ?? null)}`);
    lines.push(`Longest: ${this.formatTimedQuestion(row?.longestMs ?? null, row?.longestQuestion ?? null)}`);
    lines.push(`Grade: ${this.formatGrade(row?.grade ?? 0)} (1 per correct, +0.2 if correct and under 3s or any reply under 0.2s)`);
    return lines.join('\n');
  }

  formatTimedQuestion(ms: number | null | undefined, questionNumber: number | null | undefined): string {
    if (ms == null) {
      return '—';
    }
    const label = this.formatResponseTime(ms);
    return questionNumber != null ? `${label} (Q${questionNumber})` : label;
  }

  private formatClock(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}
